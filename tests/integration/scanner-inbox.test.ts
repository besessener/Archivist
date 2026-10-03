import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanDirectoryInput, ScanDirectoryResult } from '../../packages/core/src/workers/tasks';
import { createTestApp, type TestApp } from '../helpers/harness';
import { topicNoteClassification } from '../helpers/document-classifications';

let app: TestApp;

async function scan() {
  await app.ok('scanner:start', {});
  await app.services.jobs.whenIdle();
}

async function analyze(fileIds: string[]) {
  await app.ok('scanner:analyze', { fileIds, confirmLlm: true });
  await app.services.jobs.whenIdle();
}

const files = async () => (await app.ok('scanner:getResults', {})).files;
const fileNamed = async (name: string) => (await files()).find((f) => f.name === name)!;

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ scan: { enabled: true } });
  app.llm.on('DocumentClassification', () => topicNoteClassification('Hauskauf'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

describe('scanner duplicate detection across active document states', () => {
  it('treats a file already uploaded to the inbox as a duplicate instead of creating a second entry', async () => {
    const src = app.file('Downloads/vertrag.txt', 'Kaufvertrag Musterstraße 1, unterschrieben.');
    const imported = await app.ok('documents:import', { paths: [src] });
    await app.services.jobs.whenIdle();
    const uploadId = imported.imported[0]!.id;
    expect((await app.ok('documents:get', { id: uploadId })).status).toBe('proposed');

    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    const f = await fileNamed('vertrag.txt');
    expect(f.status).toBe('duplicate');
    expect(f.duplicateOfDocumentId).toBe(uploadId);

    await analyze([f.id]);
    expect(await app.ok('documents:list', {})).toHaveLength(1);
  });

  it('marks a scanned file as duplicate once the same content is uploaded later, and frees it when that entry is gone', async () => {
    app.file('Downloads/notiz.txt', 'Notiz zum Hauskauf mit Termin beim Notar.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    expect((await fileNamed('notiz.txt')).status).toBe('new');

    const upload = app.file('elsewhere/notiz-kopie.txt', 'Notiz zum Hauskauf mit Termin beim Notar.');
    const imported = await app.ok('documents:import', { paths: [upload] });
    await app.services.jobs.whenIdle();
    const uploadId = imported.imported[0]!.id;
    await scan();
    let f = await fileNamed('notiz.txt');
    expect(f.status).toBe('duplicate');
    expect(f.duplicateOfDocumentId).toBe(uploadId);

    await app.ok('documents:archive', { items: [{ documentId: uploadId, mode: 'ignore' }], confirmed: true, approveNewCategories: [], confirmMove: false });
    await scan();
    f = await fileNamed('notiz.txt');
    expect(f.status).toBe('new');
    expect(f.duplicateOfDocumentId).toBeNull();
  });

  it('creates only one inbox entry for identical files in two roots and for a "(1)" copy', async () => {
    const content = 'Grundbuchauszug Musterstraße 1, Blatt 42.';
    app.file('Downloads/grundbuch.txt', content);
    app.file('Downloads/grundbuch (1).txt', content);
    app.file('Dokumente/grundbuch.txt', content);
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Dokumente'), recursive: true });
    await scan();
    const all = await files();
    expect(all).toHaveLength(3);

    await analyze(all.map((f) => f.id));
    const docs = await app.ok('documents:list', {});
    expect(docs).toHaveLength(1);
    const after = await files();
    expect(after.filter((f) => f.status === 'analyzed')).toHaveLength(1);
    expect(after.filter((f) => f.status === 'duplicate').map((f) => f.duplicateOfDocumentId)).toEqual([docs[0]!.id, docs[0]!.id]);
  });

  it('updates the existing inbox entry when a scanned file changes instead of adding a second document', async () => {
    const src = app.file('Downloads/budget.txt', 'Budget Hauskauf: 300.000 Euro.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    await analyze([(await fileNamed('budget.txt')).id]);
    const before = (await app.ok('documents:list', {}))[0]!;
    expect(before.status).toBe('proposed');
    expect(await app.ok('scanner:proposals', {})).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(src, 'Budget Hauskauf: 320.000 Euro (erhöht).');
    await scan();
    const changed = await fileNamed('budget.txt');
    expect(changed.status).toBe('changed');
    // the stale proposal is no longer offered for the changed file
    expect(await app.ok('scanner:proposals', {})).toHaveLength(0);

    await analyze([changed.id]);
    const docs = await app.ok('documents:list', {});
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(before.id);
    expect(docs[0]!.status).toBe('proposed');
    expect(docs[0]!.sha256).not.toBe(before.sha256);
    expect(docs[0]!.sha256).toBe((await fileNamed('budget.txt')).sha256);
    expect((await fileNamed('budget.txt')).status).toBe('analyzed');
    expect((await app.ok('scanner:proposals', {}))[0]!.documentIds).toEqual([before.id]);
  });
});

describe('scanner paging and unreadable areas', () => {
  it('records every file across several pages, pages through the results and removes a vanished file', async () => {
    for (const n of ['a', 'b', 'c', 'f']) app.file(`Downloads/${n}.txt`, `Datei ${n} mit eigenem Inhalt.`);
    app.file('Downloads/d/e.txt', 'Datei e im Unterordner.');
    app.file('Downloads/d/g.txt', 'Datei g im Unterordner.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    app.services.scanner.pageSize = 2;
    await scan();
    const res = await app.ok('scanner:getResults', {});
    expect(res.lastSummary).toMatchObject({ scanned: 6, newFiles: 6 });
    expect(res.files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'e.txt', 'f.txt', 'g.txt']);
    expect(await app.ok('notifications:list', {})).not.toContainEqual(expect.objectContaining({ title: 'Scan-Limit erreicht' }));
    const second = await app.ok('scanner:getResults', { limit: 4, offset: 4 });
    expect(second).toMatchObject({ total: 6, files: expect.any(Array) });
    expect(second.files).toHaveLength(2);

    fs.rmSync(path.join(app.home, 'Downloads', 'c.txt'));
    await scan();
    const again = await app.ok('scanner:getResults', {});
    expect(again.lastSummary).toMatchObject({ scanned: 5, unchanged: 5 });
    expect(again.files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt', 'e.txt', 'f.txt', 'g.txt']);
  });

  it('does not treat files in an unreadable subfolder as vanished', async () => {
    app.file('Downloads/a.txt', 'Datei A.');
    app.file('Downloads/sub/b.txt', 'Datei B im Unterordner.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    expect(await files()).toHaveLength(2);

    // simulate a subfolder that cannot be read during this scan (e.g. locked network share)
    const pool = app.services.pool;
    const run = pool.run.bind(pool);
    vi.spyOn(pool, 'run').mockImplementation(async (task: string, payload: unknown) => {
      const out = await run(task as never, payload as never);
      if (task !== 'scanDirectory') return out;
      const res = out as ScanDirectoryResult;
      const sub = path.join((payload as ScanDirectoryInput).root, 'sub');
      return {
        ...res,
        entries: res.entries.filter((e) => !e.path.startsWith(sub + path.sep)),
        errors: [...res.errors, `${sub}: EACCES: permission denied`],
        unreadable: [...res.unreadable, sub],
      };
    });
    await scan();
    const res = await app.ok('scanner:getResults', {});
    expect(res.files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt']);
    expect(res.lastSummary!.errors.some((e) => e.includes('EACCES'))).toBe(true);

    // once readable again and really gone, the file leaves the list
    vi.restoreAllMocks();
    fs.rmSync(path.join(app.home, 'Downloads', 'sub'), { recursive: true });
    await scan();
    expect((await files()).map((f) => f.name)).toEqual(['a.txt']);
  });
});

describe('scan status after undoing an archiving', () => {
  it('resets the scan file to analyzed so it is offered again in the assignment proposals', async () => {
    app.file('Downloads/kaufvertrag.txt', 'Kaufvertrag zum Hauskauf Musterstraße 1.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    await analyze([(await fileNamed('kaufvertrag.txt')).id]);
    const docId = (await app.ok('scanner:proposals', {}))[0]!.documentIds[0]!;

    const archived = await app.ok('documents:archive', {
      items: [{ documentId: docId, mode: 'copy' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    });
    expect(archived.success).toBe(1);
    expect((await fileNamed('kaufvertrag.txt')).status).toBe('archived');
    expect(await app.ok('scanner:proposals', {})).toHaveLength(0);

    const undone = await app.ok('documents:undoArchive', { auditId: archived.items[0]!.auditId! });
    expect(undone.undone).toBe(true);
    const f = await fileNamed('kaufvertrag.txt');
    expect(f.status).toBe('analyzed');
    expect(f.documentId).toBe(docId);
    expect((await app.ok('scanner:proposals', {}))[0]!.documentIds).toEqual([docId]);

    // a later scan keeps that state (content unchanged)
    await scan();
    expect((await fileNamed('kaufvertrag.txt')).status).toBe('analyzed');
  });

  it('keeps the analyzed state after undoing a move that restored the original with a new timestamp', async () => {
    const src = app.file('Downloads/umzug.txt', 'Umzugsplanung 2026, Termin fix.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await scan();
    await analyze([(await fileNamed('umzug.txt')).id]);
    const docId = (await app.ok('documents:list', {}))[0]!.id;
    const moved = await app.ok('documents:archive', {
      items: [{ documentId: docId, mode: 'move' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: true,
    });
    expect(fs.existsSync(src)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.ok('documents:undoArchive', { auditId: moved.items[0]!.auditId! })).undone).toBe(true);
    expect(fs.existsSync(src)).toBe(true);
    expect((await fileNamed('umzug.txt')).status).toBe('analyzed');

    await scan();
    const res = await app.ok('scanner:getResults', {});
    expect(res.files.find((f) => f.name === 'umzug.txt')!.status).toBe('analyzed');
    expect(res.lastSummary).toMatchObject({ changedFiles: 0, unchanged: 1 });
    expect((await app.ok('notifications:list', {})).some((n) => n.type === 'file_changed')).toBe(false);
  });
});
