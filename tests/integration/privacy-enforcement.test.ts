import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionInput } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const SECRET = 'Gehaltsliste';
const cls = (topic: string) => ({
  docType: 'Notiz',
  title: `Notiz ${topic}`,
  summary: `Notiz zu ${topic}.`,
  mainTopic: topic,
  project: null,
  persons: [],
  dates: [],
  tags: [topic.toLowerCase()],
  location: { categoryPath: `work/projects/${topic}`, fileName: null, newMainCategory: false, rationale: `Bezug zu ${topic}`, confidence: 0.8 },
  decisions: [],
  openItems: [],
  confidence: 0.8,
  rationale: 'test',
});
const answer = {
  answer: 'Antwort.',
  facts: [],
  uncertainties: [],
  contradictions: [],
  missingInformation: [],
  usedSourceIds: ['S1'],
  confidence: 0.8,
};

const classifications = () => app.llm.calls.filter((c) => c.schema === 'DocumentClassification');
/** Every request body that reached the LLM endpoint (responses and embeddings). */
const sentTexts = () => [...app.llm.calls.map((c) => c.input), ...app.llm.embeddingRequests.flat()];

async function setup(mode: 'auto' | 'confirm', opts: { embeddings?: boolean } = {}) {
  app = await createTestApp({ privacy: mode, scanEnabled: true });
  if (opts.embeddings) {
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);
  }
  app.llm.on('DocumentClassification', () => cls('Personal'));
  app.llm.on('KnowledgeAnswer', () => answer);
  app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: SECRET }));
}

/** Scan folder `Downloads` with one file; `llmAllowed=false` locks the folder before scanning. */
async function scanFolder(llmAllowed: boolean, name = 'gehalt.txt') {
  const dl = path.join(app.home, 'Downloads');
  app.file(`Downloads/${name}`, `Vertrauliche ${SECRET} der Abteilung mit genug Text für die Analyse.`);
  const root = await app.ok('scanner:addDirectory', { path: dl, recursive: true });
  if (!llmAllowed) await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: false });
  await app.ok('scanner:start', { rootId: root.id });
  await app.services.jobs.whenIdle();
  const file = (await app.ok('scanner:getResults', {})).files.find((f) => f.name === name)!;
  await app.ok('scanner:analyze', { fileIds: [file.id], confirmLlm: true });
  await app.services.jobs.whenIdle();
  const doc = (await app.ok('documents:list', {})).find((d) => d.originalName === name)!;
  return { root, doc };
}

async function archive(documentId: string) {
  const plan = await app.ok('documents:previewArchive', { items: [{ documentId, mode: 'copy' }] });
  const res = await app.ok('documents:archive', {
    items: [{ documentId, mode: 'copy' }],
    confirmed: true,
    approveNewCategories: plan.newCategories,
    confirmMove: false,
  });
  expect(res.success).toBe(1);
  await app.services.documents.indexDocument(documentId);
}

async function reprocess(documentId: string) {
  await app.ok('documents:classify', { documentId, allowLlm: true });
  await app.services.jobs.whenIdle();
}

describe('folder without LLM permission: nothing reaches the LLM (#56)', () => {
  it('stores the lock on the document and honours it in scan analysis and „Erneut verarbeiten“', async () => {
    await setup('auto');
    const { doc } = await scanFolder(false);

    expect(doc.folderLlmAllowed).toBe(false);
    expect(classifications()).toHaveLength(0);

    await reprocess(doc.id);

    expect(classifications()).toHaveLength(0);
    expect(sentTexts().some((t) => t.includes(SECRET))).toBe(false);
  });

  it('applies a lock set after the analysis to existing documents and lifts it again when released', async () => {
    await setup('auto');
    const { root, doc } = await scanFolder(true);
    expect(doc.folderLlmAllowed).toBe(true);
    expect(classifications()).toHaveLength(1);

    await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: false });
    expect((await app.ok('documents:get', { id: doc.id })).folderLlmAllowed).toBe(false);
    await reprocess(doc.id);
    expect(classifications()).toHaveLength(1);
    // the folder lock is no sticky per-document exclusion
    expect((await app.ok('documents:get', { id: doc.id })).llmStatus).toBe('local_only');

    await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: true });
    expect((await app.ok('documents:get', { id: doc.id })).folderLlmAllowed).toBe(true);
    await reprocess(doc.id);
    expect(classifications()).toHaveLength(2);
  });

  it('locks files uploaded from a locked folder as well', async () => {
    await setup('auto');
    await scanFolder(false);
    const other = app.file('Downloads/upload.txt', `Noch eine ${SECRET} zum Hochladen.`);

    const imported = await app.ok('documents:import', { paths: [other] });
    await app.services.jobs.whenIdle();

    expect(imported.imported[0]!.folderLlmAllowed).toBe(false);
    expect(classifications()).toHaveLength(0);
  });

  it('does not send a locked document as chat source – it is only cited locally', async () => {
    await setup('auto');
    const { doc } = await scanFolder(false);
    await archive(doc.id);

    const r = await app.ok('chat:send', { text: `Was steht in der ${SECRET}?` });

    expect(app.llm.calls.some((c) => c.schema === 'KnowledgeAnswer')).toBe(false);
    expect(sentTexts().filter((t) => t.includes('Abteilung'))).toEqual([]);
    expect(r.assistantMessage.sources.map((s) => s.id)).toContain(doc.id);
    expect(r.assistantMessage.uncertainties.join(' ')).toMatch(/nicht an die KI gesendet/);
  });

  it('indexes a locked document with local vectors only', async () => {
    await setup('auto', { embeddings: true });
    const { doc } = await scanFolder(false);
    await archive(doc.id);

    expect(app.llm.embeddingRequests.flat().some((t) => t.includes(SECRET))).toBe(false);
  });

  it('replaces remote vectors by local ones when a folder is locked later', async () => {
    await setup('auto', { embeddings: true });
    const { root, doc } = await scanFolder(true);
    await archive(doc.id);
    const model = () =>
      app.services.database.sqlite.prepare('SELECT DISTINCT embedding_model AS m FROM chunks WHERE entity_id = ?').all(doc.id) as Array<{ m: string }>;
    expect(model().map((r) => r.m)).toEqual(['test-embedding']);

    await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: false });
    await app.services.documents.indexDocument(doc.id);

    expect(model().map((r) => r.m)).toEqual(['local-hash-v1']);
  });
});

describe('mode „vorher fragen“ (confirm): no unconfirmed transfer (#56)', () => {
  it('cites documents never released for external analysis only locally in chat answers', async () => {
    await setup('confirm');
    const { doc } = await scanFolder(true);
    // released for the folder, but analysed locally only
    await app.ok('documents:classify', { documentId: doc.id, allowLlm: false });
    await app.services.jobs.whenIdle();
    await archive(doc.id);
    expect((await app.ok('documents:get', { id: doc.id })).llmStatus).not.toBe('analyzed');
    app.llm.calls.length = 0;

    const r = await app.ok('chat:send', { text: `Was steht in der ${SECRET}?` });

    expect(app.llm.calls.some((c) => c.schema === 'KnowledgeAnswer')).toBe(false);
    expect(app.llm.calls.some((c) => c.input.includes('Abteilung'))).toBe(false);
    expect(r.assistantMessage.sources.map((s) => s.id)).toContain(doc.id);
  });

  it('sends documents the user released for external analysis as chat sources', async () => {
    await setup('confirm');
    const { doc } = await scanFolder(true);
    expect(doc.llmStatus).toBe('analyzed');
    await archive(doc.id);

    await app.ok('chat:send', { text: `Was steht in der ${SECRET}?` });

    const call = app.llm.calls.find((c) => c.schema === 'KnowledgeAnswer');
    expect(call?.input).toContain('Notiz zu Personal');
  });

  it('uses local vectors only: neither the index nor search queries go to /embeddings', async () => {
    await setup('confirm', { embeddings: true });
    const { doc } = await scanFolder(true);
    await archive(doc.id);

    const hits = await app.ok('search:global', { query: SECRET, limit: 5 });

    expect(hits.map((h) => h.id)).toContain(doc.id);
    expect(app.llm.embeddingRequests).toEqual([]);
  });
});

describe('search does not wait for a hanging embedding endpoint (#56)', () => {
  it('returns the local hits when the remote query embedding takes too long', async () => {
    await setup('auto', { embeddings: true });
    const note = app.services.graph.ensureEntity({ type: 'note', name: 'Notiz Leuchtturm', description: 'Leuchtturm am Hafen' });
    await app.services.search.index({ type: 'note', id: note.id, title: note.name, content: 'Leuchtturm am Hafen' });
    let release: () => void = () => undefined;
    app.llm.embed = (texts) =>
      new Promise((resolve) => {
        release = () => resolve(texts.map(() => [1, 0, 0]));
      });
    (app.services.search as unknown as { remoteQueryTimeoutMs: number }).remoteQueryTimeoutMs = 50;

    const started = Date.now();
    const hits = await app.ok('search:global', { query: 'Leuchtturm', limit: 5 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(hits.map((h) => h.id)).toContain(note.id);
    expect(app.llm.embeddingRequests).toEqual([['Leuchtturm']]);
    release();
  });
});

describe('Mode „vorher fragen“: no background checks with the LLM (#201)', () => {
  it('a new decision is checked for contradictions locally only – no decision text leaves the machine', async () => {
    app = await createTestApp({ privacy: 'confirm' });
    app.llm.on('ContradictionProposal', () => ({ isContradiction: true, confidence: 0.9, description: 'x' }));
    app.services.decisions.create(
      DecisionInput.parse({ decisionText: 'Wir machen mit der Solaranlage weiter.', topic: 'Strom', participants: ['Anna'], decidedAt: '2026-01-01' }),
    );
    const b = app.services.decisions.create(
      DecisionInput.parse({ decisionText: 'Wir stoppen die Solaranlage.', topic: 'Strom', participants: ['Anna'], decidedAt: '2026-02-01' }),
    );
    await app.services.contradictions.checkDecision(b.id);
    await app.services.consistency.run();
    expect(app.llm.calls.filter((c) => c.schema === 'ContradictionProposal')).toHaveLength(0);
  });

  it('in mode „automatisch“ the LLM check runs', async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.llm.on('ContradictionProposal', () => ({ isContradiction: false, confidence: 0.9, description: '' }));
    app.services.decisions.create(
      DecisionInput.parse({ decisionText: 'Wir machen mit der Solaranlage weiter.', topic: 'Strom', participants: ['Anna'], decidedAt: '2026-01-01' }),
    );
    const b = app.services.decisions.create(
      DecisionInput.parse({ decisionText: 'Wir stoppen die Solaranlage.', topic: 'Strom', participants: ['Anna'], decidedAt: '2026-02-01' }),
    );
    await app.services.contradictions.checkDecision(b.id);
    expect(app.llm.calls.filter((c) => c.schema === 'ContradictionProposal').length).toBeGreaterThan(0);
  });
});
