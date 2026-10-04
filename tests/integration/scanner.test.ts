import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { topicNoteClassification } from '../helpers/document-classifications';

let app: TestApp;

async function scan(rootId?: string) {
  const { jobId } = await app.ok('scanner:start', { rootId });
  await app.services.jobs.whenIdle();
  return jobId;
}

describe('Folder scan (default mode: local only, confirm)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'confirm' });
  });
  afterEach(async () => {
    await app.cleanup();
  });

  it('is disabled by default and requires an explicit approval', async () => {
    const dl = path.join(app.home, 'Downloads');
    fs.mkdirSync(dl);
    const root = await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    const r = await app.call('scanner:start', {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/deaktiviert/);
    expect(root.path).toBe(fs.realpathSync(dl));
  });

  it('refuses system folders, files and the data directory', async () => {
    for (const p of ['/', '/etc', '/usr/share']) expect((await app.call('scanner:addDirectory', { path: p, recursive: true })).ok).toBe(false);
    expect((await app.call('scanner:addDirectory', { path: path.join(app.home, 'gibt-es-nicht'), recursive: true })).ok).toBe(false);
    const f = app.file('x.txt', 'x');
    expect((await app.call('scanner:addDirectory', { path: f, recursive: true })).ok).toBe(false);
    expect((await app.call('scanner:addDirectory', { path: app.services.paths.root, recursive: true })).ok).toBe(false);
    expect((await app.call('scanner:addDirectory', { path: 'relativ/pfad', recursive: true })).ok).toBe(false);
  });

  it('detects new/changed files, skips known unchanged ones and respects exclusions', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    const dl = path.join(app.home, 'Downloads');
    app.file('Downloads/a.txt', 'Dokument A über Hauskauf, lang genug für den Test.');
    app.file('Downloads/b.md', '# Dokument B\nÜber Urlaub.');
    app.file('Downloads/sub/c.txt', 'Dokument C in Unterordner.');
    app.file('Downloads/ignore/d.txt', 'Dokument D im auszuschließenden Ordner.');
    app.file('Downloads/programm.exe', 'MZ');
    const root = await app.ok('scanner:addDirectory', { path: dl, recursive: true });

    await scan();
    let res = await app.ok('scanner:getResults', {});
    expect(res.files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.md', 'c.txt', 'd.txt']);
    expect(res.files.every((f) => f.status === 'new' && f.llmStatus === 'local_only')).toBe(true);
    expect(res.lastSummary).toMatchObject({ newFiles: 4, unchanged: 0 });
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((n) => n.type === 'scan_new_files' && n.title.startsWith('4 '))).toBe(true);
    // a plain scan sends nothing to the LLM
    expect(app.llm.calls).toHaveLength(0);

    // second scan: everything unchanged → nothing reprocessed
    await scan();
    res = await app.ok('scanner:getResults', {});
    expect(res.lastSummary).toMatchObject({ newFiles: 0, changedFiles: 0, unchanged: 4 });

    // a change is detected
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(path.join(dl, 'a.txt'), '\nNeue Zeile.');
    await scan();
    res = await app.ok('scanner:getResults', {});
    expect(res.lastSummary).toMatchObject({ newFiles: 0, changedFiles: 1, unchanged: 3 });
    expect(res.files.find((f) => f.name === 'a.txt')!.status).toBe('changed');

    // exclusions (file + folder) take effect on the next scan
    await app.ok('scanner:exclude', { kind: 'dir', path: path.join(dl, 'ignore') });
    await app.ok('scanner:exclude', { kind: 'file', path: path.join(dl, 'b.md') });
    expect(
      (await app.ok('scanner:getResults', {})).files
        .filter((f) => f.status === 'excluded')
        .map((f) => f.name)
        .sort(),
    ).toEqual(['b.md', 'd.txt']);
    fs.appendFileSync(path.join(dl, 'b.md'), '\nmehr');
    await scan();
    res = await app.ok('scanner:getResults', {});
    expect(res.files.find((f) => f.name === 'b.md')!.status).toBe('excluded');
    expect(res.lastSummary!.scanned).toBe(2); // a.txt + c.txt (d.txt and b.md excluded)
    expect((await app.ok('scanner:listExclusions', {})).length).toBe(2);

    // folder options: not recursive
    await app.ok('scanner:updateDirectory', { id: root.id, recursive: false });
    await scan();
    expect((await app.ok('scanner:getResults', {})).files.some((f) => f.name === 'c.txt')).toBe(false);
  });

  it('in confirm mode analyses only locally, sends content only after explicit approval and masks secrets', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    app.llm.on('DocumentClassification', () => topicNoteClassification('Hauskauf'));
    const dl = path.join(app.home, 'Downloads');
    app.file('Downloads/kauf.txt', 'Hauskauf Musterstraße.\npassword: hunter2xx\nKey sk-abcdefghijklmnopqrstu\nDas Budget muss noch geklärt werden.');
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await scan();
    const file = (await app.ok('scanner:getResults', {})).files[0]!;

    await app.ok('scanner:analyze', { fileIds: [file.id], confirmLlm: false });
    await app.services.jobs.whenIdle();
    expect(app.llm.calls.filter((c) => c.schema === 'DocumentClassification')).toHaveLength(0);
    let doc = (await app.ok('documents:list', {})).find((d) => d.sourcePath?.endsWith('kauf.txt'))!;
    expect(doc.status).toBe('proposed');
    expect(doc.llmStatus).toBe('pending'); // scheduled for LLM analysis
    expect(doc.proposal?.analyzedBy).toBe('local');
    expect(doc.proposal?.possibleOpenItems.length).toBeGreaterThan(0);

    // analyse again with explicit approval
    await app.ok('scanner:analyze', { fileIds: [file.id], confirmLlm: true, reanalyze: true });
    await app.services.jobs.whenIdle();
    const calls = app.llm.calls.filter((c) => c.schema === 'DocumentClassification');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).not.toContain('hunter2xx');
    expect(calls[0]!.input).not.toContain('sk-abcdefghijklmnopqrstu');
    expect(calls[0]!.input).toContain('[REDACTED');
    doc = (await app.ok('documents:list', {})).find((d) => d.sourcePath?.endsWith('kauf.txt'))!;
    expect(doc.llmStatus).toBe('analyzed');
    const tx = await app.ok('llm:transmissions', { limit: 5 });
    expect(tx[0]!.redactions).toBeGreaterThanOrEqual(2);
    expect(tx[0]!.documentIds).toContain(doc.id);
  });

  it('excludes files and folders from LLM processing', async () => {
    app.services.settings.update({ scan: { enabled: true }, privacy: { llmMode: 'auto' } });
    app.llm.on('DocumentClassification', () => topicNoteClassification('Geheim'));
    const dl = path.join(app.home, 'Downloads');
    app.file('Downloads/privat/tagebuch.txt', 'Sehr privater Inhalt.');
    app.file('Downloads/normal.txt', 'Normaler Inhalt zum Archivieren.');
    app.file('Downloads/vertraulich.txt', 'Vertraulicher Inhalt.');
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    app.services.settings.update({
      privacy: { neverAnalyzeDirs: [path.join(dl, 'privat')], neverAnalyzeFiles: [path.join(fs.realpathSync(dl), 'vertraulich.txt')] },
    });
    await scan();
    const files = (await app.ok('scanner:getResults', {})).files;
    expect(files.find((f) => f.name === 'tagebuch.txt')!.llmStatus).toBe('excluded');
    expect(files.find((f) => f.name === 'normal.txt')!.llmStatus).toBe('local_only');
    await app.ok('scanner:analyze', { fileIds: files.map((f) => f.id), confirmLlm: true });
    await app.services.jobs.whenIdle();
    expect(app.llm.calls.filter((c) => c.schema === 'DocumentClassification')).toHaveLength(1);
    const docs = await app.ok('documents:list', {});
    expect(docs.find((d) => d.originalName === 'tagebuch.txt')!.llmStatus).toBe('excluded');
    expect(docs.find((d) => d.originalName === 'vertraulich.txt')!.llmStatus).toBe('excluded');
    expect(docs.find((d) => d.originalName === 'normal.txt')!.llmStatus).toBe('analyzed');
  });

  it('privacy mode „nur lokal“ never sends content', async () => {
    app.services.settings.update({ scan: { enabled: true }, privacy: { llmMode: 'local_only' } });
    app.llm.on('DocumentClassification', () => topicNoteClassification('X'));
    app.file('Downloads/x.txt', 'Inhalt X');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    const f = (await app.ok('scanner:getResults', {})).files[0]!;
    await app.ok('scanner:analyze', { fileIds: [f.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    expect(app.llm.calls).toHaveLength(0);
    expect((await app.ok('documents:list', {}))[0]!.llmStatus).toBe('local_only');
    const chat = await app.ok('chat:send', { text: 'Wann war X?' });
    expect(app.llm.calls).toHaveLength(0);
    expect(chat.assistantMessage.content.length).toBeGreaterThan(0);
  });
});

describe('Assignment proposals and selective archiving of scanned files', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
  });
  afterEach(async () => {
    await app.cleanup();
  });

  it('proposes documents for an existing topic and archives only the selected ones', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    app.llm.on('DocumentClassification', () =>
      topicNoteClassification('Hauskauf', {
        decisions: [
          {
            title: 'Kaufentscheidung',
            decisionText: 'Wir kaufen das Haus.',
            decidedAt: '2026-05-01',
            participants: [],
            kind: 'decided',
            evidence: 'Wir kaufen das Haus.',
          },
        ],
      }),
    );
    await app.ok('knowledge:createEntity', { type: 'topic', name: 'Hauskauf' });
    const dl = path.join(app.home, 'Downloads');
    for (const n of ['kaufvertrag', 'grundbuch', 'finanzierung'])
      app.file(`Downloads/${n}.txt`, `Dokument ${n} zum Hauskauf Musterstraße 1. Wir kaufen das Haus.`);
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await scan();
    const files = (await app.ok('scanner:getResults', {})).files;
    await app.ok('scanner:analyze', { fileIds: files.map((f) => f.id), confirmLlm: true });
    await app.services.jobs.whenIdle();

    const groups = await app.ok('scanner:proposals', {});
    expect(groups).toHaveLength(1);
    expect(groups[0]!.documentIds).toHaveLength(3);
    const notes = await app.ok('notifications:list', {});
    const note = notes.find((n) => n.type === 'assignment_proposal')!;
    expect(note.title).toMatch(/3 Dokumente zu Thema „Hauskauf“/);
    const insight = (await app.ok('insights:list', {})).find((i) => i.kind === 'assignment')!;
    expect(insight.recommendedActionId).toBeTruthy();

    const chosen = groups[0]!.documentIds.slice(0, 2);
    const plan = await app.ok('documents:previewArchive', { items: chosen.map((documentId) => ({ documentId, mode: 'copy' as const })) });
    expect(plan.items.every((i) => i.sourcePath?.includes('Downloads') && i.targetPath?.includes(path.join('Arbeit', 'projects', 'Hauskauf')))).toBe(true);
    const res = await app.ok('documents:archive', {
      items: chosen.map((documentId) => ({ documentId, mode: 'copy' as const })),
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    });
    expect(res.success).toBe(2);
    const docs = await app.ok('documents:list', {});
    expect(docs.filter((d) => d.status === 'archived')).toHaveLength(2);
    expect(docs.filter((d) => d.status === 'proposed')).toHaveLength(1);
    for (const n of ['kaufvertrag', 'grundbuch', 'finanzierung']) expect(fs.existsSync(path.join(dl, `${n}.txt`))).toBe(true); // originals unchanged
    // scan results reflect the archiving status
    const after = (await app.ok('scanner:getResults', {})).files;
    expect(after.filter((f) => f.status === 'archived')).toHaveLength(2);
    // documents for the topic can be found
    const topic = (await app.ok('knowledge:listEntities', { type: 'topic' })).find((t) => t.name === 'Hauskauf')!;
    expect(await app.ok('documents:forTopic', { topicId: topic.id })).toHaveLength(2);
    // detected decisions are only proposed, not created
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    const proposed = (await app.ok('actions:list', { status: 'proposed' })).filter((a) => a.actionType === 'record_decision');
    expect(proposed.length).toBeGreaterThan(0);
  });

  it('moving requires additional confirmation, removes the original and can be undone', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    app.llm.on('DocumentClassification', () => topicNoteClassification('Umzug'));
    const dl = path.join(app.home, 'Downloads');
    const src = app.file('Downloads/umzug.txt', 'Umzugsplanung 2026, Termin fix.');
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await scan();
    const f = (await app.ok('scanner:getResults', {})).files[0]!;
    await app.ok('scanner:analyze', { fileIds: [f.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    const doc = (await app.ok('documents:list', {}))[0]!;

    const skipped = await app.ok('documents:archive', {
      items: [{ documentId: doc.id, mode: 'move' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    });
    expect(skipped.skipped).toBe(1);
    expect(fs.existsSync(src)).toBe(true);

    const moved = await app.ok('documents:archive', {
      items: [{ documentId: doc.id, mode: 'move' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: true,
    });
    expect(moved.success).toBe(1);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(moved.items[0]!.targetPath!)).toBe(true);

    const undone = await app.ok('documents:undoArchive', { auditId: moved.items[0]!.auditId! });
    expect(undone.undone).toBe(true);
    expect(fs.readFileSync(src, 'utf8')).toContain('Umzugsplanung');
    expect(fs.existsSync(moved.items[0]!.targetPath!)).toBe(false);
  });

  it('the actions „nur indexieren“ and „ignorieren“ change no files', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    app.llm.on('DocumentClassification', () => topicNoteClassification('Allgemein'));
    const a = app.file('Downloads/a.txt', 'Inhalt A zum Indexieren');
    const b = app.file('Downloads/b.txt', 'Inhalt B zum Ignorieren');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    await app.ok('scanner:analyze', { fileIds: (await app.ok('scanner:getResults', {})).files.map((f) => f.id), confirmLlm: true });
    await app.services.jobs.whenIdle();
    const docs = await app.ok('documents:list', {});
    const da = docs.find((d) => d.originalName === 'a.txt')!;
    const db = docs.find((d) => d.originalName === 'b.txt')!;
    const res = await app.ok('documents:archive', {
      items: [
        { documentId: da.id, mode: 'index_only' },
        { documentId: db.id, mode: 'ignore' },
      ],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    });
    expect(res.success).toBe(2);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    expect((await app.ok('documents:get', { id: da.id })).status).toBe('indexed_only');
    expect((await app.ok('documents:get', { id: db.id })).status).toBe('ignored');
    const hits = await app.ok('search:global', { query: 'Indexieren', limit: 5 });
    expect(hits.some((h) => h.id === da.id)).toBe(true);
  });
});
