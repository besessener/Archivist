import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REINDEX_CONCURRENCY } from '../../packages/core/src/services/reindex-refs';
import { archived } from '../helpers/agent';
import { topicNoteClassification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const jobsOfType = (type: string) => app.services.jobs.list().filter((job) => job.type === type);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Re-indexing after a merge runs as a bounded job (#224)', () => {
  it('queues one job, indexes at most two documents at a time, and reaches every document', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1)
      ids.push(await archived(app, { name: `alt-${index}.txt`, content: `Inhalt ${index} des Altberichts`, folder: 'Arbeit/notes', topic: 'Altthema' }));
    await archived(app, { name: 'neu.txt', content: 'Inhalt des Neuberichts', folder: 'Arbeit/notes', topic: 'Neuthema' });
    const graph = app.services.graph;
    const oldTopic = graph.findByName('topic', 'Altthema')!;
    const newTopic = graph.findByName('topic', 'Neuthema')!;
    const indexed: string[] = [];
    let running = 0;
    let peak = 0;
    const original = app.services.documents.indexDocument.bind(app.services.documents);
    vi.spyOn(app.services.documents, 'indexDocument').mockImplementation(async (id) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(15);
      await original(id);
      running -= 1;
      indexed.push(id);
    });

    await graph.merge({ sourceIds: [oldTopic.id], targetId: newTopic.id });
    expect(jobsOfType('search.reindex-refs')).toHaveLength(1);
    await app.services.jobs.whenIdle();

    expect(jobsOfType('search.reindex-refs')[0]).toMatchObject({ status: 'succeeded' });
    expect(peak).toBe(REINDEX_CONCURRENCY);
    expect(new Set(indexed)).toEqual(new Set(ids));
  });

  it('queues nothing when a merge touches no indexed record', async () => {
    const graph = app.services.graph;
    const first = graph.ensureEntity({ type: 'topic', name: 'Leer A' });
    const second = graph.ensureEntity({ type: 'topic', name: 'Leer B' });

    await graph.merge({ sourceIds: [first.id], targetId: second.id });
    await app.services.jobs.whenIdle();

    expect(jobsOfType('search.reindex-refs')).toHaveLength(0);
  });

  it('a failing record does not stop the others', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1)
      ids.push(await archived(app, { name: `alt-${index}.txt`, content: `Inhalt ${index} des Altberichts`, folder: 'Arbeit/notes', topic: 'Altthema' }));
    await archived(app, { name: 'neu.txt', content: 'Inhalt des Neuberichts', folder: 'Arbeit/notes', topic: 'Neuthema' });
    const graph = app.services.graph;
    const indexed: string[] = [];
    const original = app.services.documents.indexDocument.bind(app.services.documents);
    vi.spyOn(app.services.documents, 'indexDocument').mockImplementation(async (id) => {
      if (id === ids[0]) throw new Error('kaputt');
      indexed.push(id);
      await original(id);
    });

    await graph.merge({ sourceIds: [graph.findByName('topic', 'Altthema')!.id], targetId: graph.findByName('topic', 'Neuthema')!.id });
    await app.services.jobs.whenIdle();

    expect(jobsOfType('search.reindex-refs')[0]).toMatchObject({ status: 'succeeded', summary: expect.stringContaining('2 von 3') });
    expect(new Set(indexed)).toEqual(new Set(ids.slice(1)));
  });
});

describe('Withdrawing the LLM permission of a scan folder re-indexes its documents bounded (#224)', () => {
  it('indexes at most two documents at a time and reaches every locked document', async () => {
    app.llm.on('DocumentClassification', () => topicNoteClassification('Ordner'));
    const folder = path.join(app.home, 'Downloads');
    const files = Array.from({ length: 6 }, (_, index) => app.file(`Downloads/datei-${index}.txt`, `Inhalt ${index} der Datei im Ordner Downloads.`));
    const root = await app.ok('scanner:addDirectory', { path: folder, recursive: true });
    const { imported } = await app.ok('documents:import', { paths: files });
    await app.services.jobs.whenIdle();
    const indexed: string[] = [];
    let running = 0;
    let peak = 0;
    const original = app.services.documents.indexDocument.bind(app.services.documents);
    vi.spyOn(app.services.documents, 'indexDocument').mockImplementation(async (id) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(15);
      await original(id);
      running -= 1;
      indexed.push(id);
    });

    await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: false });
    await vi.waitFor(() => expect(indexed).toHaveLength(imported.length));

    expect(peak).toBe(REINDEX_CONCURRENCY);
    expect(new Set(indexed)).toEqual(new Set(imported.map((document) => document.id)));
  });
});

describe('Re-indexing embeds only changed chunks (#224)', () => {
  beforeEach(() => {
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);
  });

  const paragraphs = Array.from(
    { length: 40 },
    (_, index) => `Absatz ${index}: Die Abteilung prüft den Vorgang ${index} und hält das Ergebnis schriftlich fest.`,
  ).join('\n\n');
  const note = (content: string, title = 'Langes Protokoll') => ({ type: 'note' as const, id: 'note-1', title, content, allowRemoteEmbedding: true });
  const sentTexts = () => app.llm.embeddingRequests.flat().length;
  const chunkCount = () => (app.services.database.sqlite.prepare("SELECT count(*) AS n FROM chunks WHERE entity_id = 'note-1'").get() as { n: number }).n;
  const remoteChunks = () =>
    (
      app.services.database.sqlite.prepare("SELECT count(*) AS n FROM chunks WHERE entity_id = 'note-1' AND embedding_model = 'test-embedding'").get() as {
        n: number;
      }
    ).n;

  it('sends nothing when the entry is unchanged', async () => {
    await app.services.search.index(note(paragraphs));
    const total = chunkCount();
    expect(total).toBeGreaterThan(2);
    expect(sentTexts()).toBe(total);
    app.llm.embeddingRequests.length = 0;

    await app.services.search.index(note(paragraphs));

    expect(sentTexts()).toBe(0);
    expect(chunkCount()).toBe(total);
    expect(remoteChunks()).toBe(total);
  });

  it('sends only the chunks whose text changed', async () => {
    await app.services.search.index(note(paragraphs));
    const total = chunkCount();
    app.llm.embeddingRequests.length = 0;

    await app.services.search.index(note(`${paragraphs}\n\nAbsatz neu: Ein Nachtrag am Ende.`));

    expect(sentTexts()).toBeGreaterThan(0);
    expect(sentTexts()).toBeLessThan(total);
    expect(remoteChunks()).toBe(chunkCount());
  });

  it('sends everything again when the title changed, because it is part of what is embedded', async () => {
    await app.services.search.index(note(paragraphs));
    const total = chunkCount();
    app.llm.embeddingRequests.length = 0;

    await app.services.search.index(note(paragraphs, 'Anderer Titel'));

    expect(sentTexts()).toBe(total);
  });

  it('keeps the transmission log in line with the fewer requests', async () => {
    await app.services.search.index(note(paragraphs));
    const before = (await app.ok('llm:transmissions', { limit: 100 })).length;

    await app.services.search.index(note(paragraphs));

    expect((await app.ok('llm:transmissions', { limit: 100 })).length).toBe(before);
  });
});

describe('A remote embedding failure heals later (#224)', () => {
  beforeEach(() => {
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);
  });

  it('queues the re-embedding job when an entry fell back to local vectors, and moves it once the endpoint is back', async () => {
    app.llm.down = true;
    const created = await app.ok('events:create', { title: 'Auftakt', occurredAt: '2026-09-02', sourceIds: [] });

    await vi.waitFor(() => expect(jobsOfType('search.reembed')).toHaveLength(1));
    const modelOf = () =>
      (app.services.database.sqlite.prepare('SELECT embedding_model AS model FROM chunks WHERE entity_id = ?').get(created.id) as { model: string }).model;
    expect(modelOf()).toBe('local-hash-v1');

    app.llm.down = false;
    await app.services.jobs.whenIdle();
    const [job] = jobsOfType('search.reembed');
    if (job!.status === 'failed') {
      app.services.jobs.retry(job!.id);
      await app.services.jobs.whenIdle();
    }

    expect(modelOf()).toBe('test-embedding');
  });

  it('does not queue a second job while one covers the request', async () => {
    app.llm.down = true;
    const entry = { type: 'note' as const, allowRemoteEmbedding: true, title: 'Notiz', content: 'Ein kurzer Text.' };
    await app.services.search.index({ ...entry, id: 'note-1' });
    await app.services.search.index({ ...entry, id: 'note-2' });

    expect(jobsOfType('search.reembed').length).toBeLessThanOrEqual(2);
    app.llm.down = false;
    await app.services.jobs.whenIdle();
  });

  it('queues nothing when local vectors were wanted anyway', async () => {
    await app.services.search.index({ type: 'note', id: 'note-1', title: 'Notiz', content: 'Ein kurzer Text.', allowRemoteEmbedding: false });

    expect(jobsOfType('search.reembed')).toHaveLength(0);
  });
});
