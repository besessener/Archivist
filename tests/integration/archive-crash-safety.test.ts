import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

// Read-only files, a failing audit write and a failing undo commit: nothing is lost and nothing piles up.

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () => classification({ title: 'Testdokument', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes' }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const row = (id: string) => app.services.documents.getRow(id);
const filesIn = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });
const realOpen = fsp.open.bind(fsp);

/** Opening a read-only file for writing fails, as on Windows or for a non-root user (the tests may run as root). */
const enforceReadOnly = () =>
  vi.spyOn(fsp, 'open').mockImplementation(async (p, flags, mode) => {
    if (flags === 'r+' && ((await fsp.stat(p)).mode & 0o200) === 0) throw errno('EPERM');
    return realOpen(p, flags, mode);
  });

async function imported(name: string, content: string) {
  const src = app.file(`in/${name}`, content);
  const imp = await app.ok('documents:import', { paths: [src] });
  await app.services.jobs.whenIdle();
  return { src, id: imp.imported[0]!.id };
}

const archive = (documentId: string) =>
  app.ok('documents:archive', {
    items: [{ documentId, mode: 'copy', categoryPath: 'Arbeit/notes' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);

describe('Read-only files', () => {
  it('are archived, keep their read-only flag and can be moved to the trash', async () => {
    const { src, id } = await imported('schreibgeschuetzt.txt', 'Schreibgeschützter Anhang');
    fs.chmodSync(src, 0o444);
    fs.chmodSync(row(id).stagedPath!, 0o444);
    enforceReadOnly();

    const res = await archive(id);

    expect(res).toMatchObject({ success: 1, failed: 0 });
    const target = res.items[0]!.targetPath!;
    expect(fs.readFileSync(target, 'utf8')).toBe('Schreibgeschützter Anhang');
    expect(fs.statSync(target).mode & 0o222).toBe(0);

    await app.ok('documents:trash', { id, confirmed: true });

    expect(fs.existsSync(target)).toBe(false);
    expect(filesIn(app.services.paths.trash).map((f) => fs.readFileSync(f, 'utf8'))).toContain('Schreibgeschützter Anhang');
  });
});

describe('Archiving: the audit entry cannot be written', () => {
  it('rolls the archiving back with the copy, so no archived document is left without undo', async () => {
    const { src, id } = await imported('ohne-protokoll.txt', 'Dokument ohne Protokolleintrag');
    const staged = row(id).stagedPath!;
    const log = app.services.audit.log.bind(app.services.audit);
    vi.spyOn(app.services.audit, 'log').mockImplementation((input) => {
      if (input.action === 'archive.copy' && input.success !== false) throw new Error('SQLITE_FULL: database or disk is full');
      return log(input);
    });

    const res = await archive(id);

    expect(res).toMatchObject({ success: 0, failed: 1 });
    expect(row(id)).toMatchObject({ status: 'proposed', archiveRelPath: null, stagedPath: staged });
    expect(filesIn(archiveRoot())).toEqual([]);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.existsSync(src)).toBe(true);
  });
});

describe('Undo: the database refuses after the archived version was put back', () => {
  async function scanned(name: string, content: string) {
    app.services.settings.update({ scan: { enabled: true } });
    const dl = path.join(app.home, 'Downloads');
    const src = app.file(`Downloads/${name}`, content);
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const file = (await app.ok('scanner:getResults', {})).files.find((x) => x.name === name)!;
    await app.ok('scanner:analyze', { fileIds: [file.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    return { src, dl, id: (await app.ok('documents:list', {})).find((d) => d.originalName === name)!.id };
  }

  it('takes the put-back copy away again, so a retry leaves exactly one „Name (2).ext“', async () => {
    const a = await scanned('bericht.txt', 'Archivierte Fassung');
    const res = await archive(a.id);
    const auditId = res.items[0]!.auditId!;
    fs.writeFileSync(a.src, 'Später bearbeitete Fassung');
    vi.spyOn(app.services.graph, 'revertRelationChanges').mockImplementationOnce(() => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });

    const failed = await app.call('documents:undoArchive', { auditId });

    expect(failed.ok).toBe(false);
    expect(fs.readdirSync(a.dl)).toEqual(['bericht.txt']);
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(true);

    const retry = await app.ok('documents:undoArchive', { auditId });

    expect(retry).toMatchObject({ undone: true, conflicts: [] });
    expect(fs.readdirSync(a.dl).sort()).toEqual(['bericht (2).txt', 'bericht.txt']);
    expect(fs.readFileSync(path.join(a.dl, 'bericht (2).txt'), 'utf8')).toBe('Archivierte Fassung');
    expect(fs.readFileSync(a.src, 'utf8')).toBe('Später bearbeitete Fassung');
  });
});
