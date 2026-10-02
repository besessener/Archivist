import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

// File system calls fail halfway (EBUSY, ENOSPC, EXDEV): the state stays unambiguous and the message matches it.

const TOPIC = 'Bildungsurlaub 2026';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const row = (id: string) => app.services.documents.getRow(id);
const abs = (id: string) => path.join(archiveRoot(), ...row(id).archiveRelPath!.split('/'));
const filesIn = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

const realUnlink = fsp.unlink.bind(fsp);
const realCopyFile = fsp.copyFile.bind(fsp);

/** unlink fails with EBUSY for the paths matching `locked` (like a file open in a viewer on Windows). */
const lockForUnlink = (locked: (p: string) => boolean) =>
  vi.spyOn(fsp, 'unlink').mockImplementation(async (p) => {
    if (locked(String(p))) throw errno('EBUSY');
    return realUnlink(p);
  });

/** copyFile writes half of the file and then fails with ENOSPC (disk full). */
const diskFullDuringCopy = () =>
  vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dest) => {
    const data = await fsp.readFile(String(src));
    await fsp.writeFile(String(dest), data.subarray(0, Math.ceil(data.length / 2)), { flag: 'wx' });
    throw errno('ENOSPC');
  });

function classifyAs(name: string, loc: string, topic: string | null) {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title: name,
    summary: `Zusammenfassung ${name}`,
    mainTopic: topic,
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: loc, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
}

async function imported(name: string, content: string, loc = 'work/notes', topic: string | null = TOPIC) {
  classifyAs(name, loc, topic);
  const src = app.file(`in/${name}`, content);
  const imp = await app.ok('documents:import', { paths: [src] });
  await app.services.jobs.whenIdle();
  return { src, id: imp.imported[0]!.id };
}

const archive = (documentId: string, categoryPath = 'work/notes', topic: string | null = TOPIC) =>
  app.ok('documents:archive', {
    items: [{ documentId, mode: 'copy', categoryPath, topic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);

async function archived(name: string, content: string, loc: string): Promise<string> {
  const { id } = await imported(name, content, loc);
  const res = await archive(id, loc);
  expect(res.success).toBe(1);
  return id;
}

describe('Archiving: the inbox copy cannot be removed after the commit', () => {
  it('stays validly archived with an undo entry; the inbox copy is marked and removed later', async () => {
    const { src, id } = await imported('offen.txt', 'Im Viewer geöffnetes Dokument');
    const staged = row(id).stagedPath!;
    lockForUnlink((p) => p === staged);

    const res = await archive(id);

    expect(res).toMatchObject({ success: 1, failed: 0 });
    expect(res.items[0]!.message).toMatch(/Kopie im Eingang .* später automatisch entfernt/);
    expect(res.items[0]!.auditId).toBeTruthy();
    expect(row(id)).toMatchObject({ status: 'archived', stagedPath: staged });
    expect(fs.readFileSync(res.items[0]!.targetPath!, 'utf8')).toBe('Im Viewer geöffnetes Dokument');
    expect(fs.existsSync(staged)).toBe(true);
    expect(app.services.audit.list(10, true).some((e) => e.id === res.items[0]!.auditId)).toBe(true);

    // still locked: the cleanup leaves the copy and the mark in place
    expect(await app.services.archive.cleanupInbox()).toBe(0);
    expect(row(id).stagedPath).toBe(staged);

    vi.restoreAllMocks();
    const updatedAt = row(id).updatedAt;
    expect(await app.services.archive.cleanupInbox()).toBe(1);
    expect(fs.existsSync(staged)).toBe(false);
    expect(row(id).stagedPath).toBeNull();
    expect(row(id).updatedAt, 'completing the archiving keeps the undo possible').toBe(updatedAt);

    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo).toMatchObject({ undone: true, conflicts: [] });
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  it('cleans up marked copies on the next archiving and during the archive check', async () => {
    const a = await imported('a.txt', 'Dokument A mit Inhalt');
    const b = await imported('b.txt', 'Dokument B mit Inhalt');
    const stagedA = row(a.id).stagedPath!;
    const lock = lockForUnlink((p) => p === stagedA);
    await archive(a.id);
    lock.mockRestore();

    await archive(b.id);

    expect(fs.existsSync(stagedA)).toBe(false);
    expect(row(a.id).stagedPath).toBeNull();

    // via the archive check job
    const c = await imported('c.txt', 'Dokument C mit Inhalt');
    const stagedC = row(c.id).stagedPath!;
    const lockC = lockForUnlink((p) => p === stagedC);
    await archive(c.id);
    lockC.mockRestore();
    app.services.enqueueConsistency('test');
    await app.services.jobs.whenIdle();
    expect(fs.existsSync(stagedC)).toBe(false);
    expect(row(c.id).stagedPath).toBeNull();
  });

  it('never removes the inbox copy when the archive file is missing or was changed', async () => {
    const { id } = await imported('x.txt', 'Dokument X mit Inhalt');
    const staged = row(id).stagedPath!;
    const lock = lockForUnlink((p) => p === staged);
    const res = await archive(id);
    lock.mockRestore();
    fs.appendFileSync(res.items[0]!.targetPath!, ' – bearbeitet');

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.readFileSync(staged, 'utf8')).toBe('Dokument X mit Inhalt');
    expect(row(id).stagedPath).toBe(staged);
  });

  it('undo also works while the inbox copy is still marked', async () => {
    const { id } = await imported('y.txt', 'Dokument Y mit Inhalt');
    const staged = row(id).stagedPath!;
    const lock = lockForUnlink((p) => p === staged);
    const res = await archive(id);
    lock.mockRestore();

    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });

    expect(undo).toMatchObject({ undone: true, conflicts: [] });
    expect(row(id)).toMatchObject({ status: 'proposed', stagedPath: staged });
    expect(fs.readFileSync(staged, 'utf8')).toBe('Dokument Y mit Inhalt');
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(false);
  });
});

describe('Archiving: the copy aborts midway', () => {
  it('leaves no partial copy in the archive and reports „nichts verändert“', async () => {
    const { id } = await imported('gross.txt', 'Ein großes Dokument, das nicht ganz passt');
    const staged = row(id).stagedPath!;
    diskFullDuringCopy();

    const res = await archive(id);

    expect(res).toMatchObject({ success: 0, failed: 1 });
    expect(res.items[0]!.message).toMatch(/ENOSPC.*nichts verändert/);
    expect(filesIn(archiveRoot())).toEqual([]);
    expect(row(id)).toMatchObject({ status: 'proposed', stagedPath: staged });
    expect(fs.existsSync(staged)).toBe(true);
  });

  it('reports a partial copy that cannot be removed, with its path', async () => {
    const { id } = await imported('gross.txt', 'Ein großes Dokument, das nicht ganz passt');
    diskFullDuringCopy();
    lockForUnlink((p) => p.startsWith(archiveRoot()));

    const res = await archive(id);

    expect(res.failed).toBe(1);
    const leftover = filesIn(archiveRoot());
    expect(leftover).toHaveLength(1);
    expect(res.items[0]!.message).toContain('unvollständige Kopie');
    expect(res.items[0]!.message).toContain(leftover[0]!);
    expect(res.items[0]!.message).not.toMatch(/nichts verändert/);
    expect(row(id).status).toBe('proposed');
  });
});

describe('Relocating with partial failures', () => {
  it('hardlink created, original locked: the new entry is rolled back, nothing is changed', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');
    const original = abs(id);
    lockForUnlink((p) => p === original);

    const res = await app.services.archive.relocate([{ documentId: id, categoryPath: 'work/neu' }], { confirmed: true });

    expect(res).toMatchObject({ success: 0, failed: 1 });
    expect(res.items[0]!.message).toMatch(/EBUSY.*nichts verändert/);
    expect(filesIn(archiveRoot())).toEqual([original]);
    expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
  });

  it('hardlink remains because the rollback fails too: the message names the additional entry', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');
    const original = abs(id);
    lockForUnlink((p) => p.startsWith(archiveRoot()));

    const res = await app.services.archive.relocate([{ documentId: id, categoryPath: 'work/neu' }], { confirmed: true });

    expect(res.failed).toBe(1);
    const extra = path.join(archiveRoot(), 'work', 'neu', 'antrag.txt');
    expect(fs.existsSync(extra)).toBe(true);
    expect(fs.existsSync(original)).toBe(true);
    expect(res.items[0]!.message).toContain('Hardlink');
    expect(res.items[0]!.message).toContain(extra);
    expect(res.items[0]!.message).not.toMatch(/nichts verändert/);
    expect(row(id).archiveRelPath, 'the database still points to the original, which still exists').toBe('work/hr/antrag.txt');
  });

  it('without hardlinks: an aborted copy is removed', async () => {
    const id = await archived('antrag.txt', 'Antrag auf Bildungsurlaub', 'work/hr');
    const original = abs(id);
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EXDEV'));
    diskFullDuringCopy();

    const res = await app.services.archive.relocate([{ documentId: id, categoryPath: 'work/neu' }], { confirmed: true });

    expect(res.failed).toBe(1);
    expect(res.items[0]!.message).toMatch(/ENOSPC.*nichts verändert/);
    expect(filesIn(archiveRoot())).toEqual([original]);
    expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
  });

  it('without hardlinks: copy succeeds, original locked – the copy is removed again', async () => {
    const id = await archived('antrag.txt', 'Antrag auf Bildungsurlaub', 'work/hr');
    const original = abs(id);
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EXDEV'));
    vi.spyOn(fsp, 'copyFile').mockImplementation((s, d, m) => realCopyFile(s, d, m));
    lockForUnlink((p) => p === original);

    const res = await app.services.archive.relocate([{ documentId: id, categoryPath: 'work/neu' }], { confirmed: true });

    expect(res.failed).toBe(1);
    expect(filesIn(archiveRoot())).toEqual([original]);
  });

  it('database error after moving: the file is back at its old location, with no leftovers', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');
    const original = abs(id);
    vi.spyOn(app.services.categories, 'create').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const res = await app.services.archive.relocate([{ documentId: id, categoryPath: 'work/neu' }], { confirmed: true });

    expect(res.failed).toBe(1);
    expect(filesIn(archiveRoot())).toEqual([original]);
    expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
  });
});

describe('Relocation proposal: „0 verschoben“ is not a success', () => {
  async function scatteredInsight() {
    await archived('a.txt', 'Inhalt A', 'work/a');
    await archived('b.txt', 'Inhalt B', 'work/a');
    const c = await archived('c.txt', 'Inhalt C', 'work/c');
    await app.services.consistency.run('test');
    const insight = app.services.insights.list('open').find((i) => i.kind === 'scattered_documents')!;
    expect(insight.recommendedActionId).toBeTruthy();
    return { c, insight };
  }

  it('reports „fehlgeschlagen“, the insight stays open and can be run again after the next check', async () => {
    const { c, insight } = await scatteredInsight();
    fs.appendFileSync(abs(c), ' – bearbeitet'); // conflict: nothing can be moved

    await expect(app.services.insights.accept(insight.id, {})).rejects.toThrow(/nichts verschoben/);

    expect(app.services.insights.get(insight.id).status).toBe('open');
    const failed = app.services.actions.get(insight.recommendedActionId!);
    expect(failed.status).toBe('failed');
    expect(failed.result).toMatch(/0 verschoben.*1 Konflikte.*verändert/);
    expect(row(c).archiveRelPath).toBe('work/c/c.txt');

    // the cause is gone; the next archive check offers a fresh proposal on the same hint
    fs.writeFileSync(abs(c), 'Inhalt C');
    await app.services.consistency.run('test');
    const again = app.services.insights.get(insight.id);
    expect(again.status).toBe('open');
    expect(again.recommendedActionId).not.toBe(insight.recommendedActionId);

    await app.services.insights.accept(insight.id, {});

    expect(app.services.insights.get(insight.id).status).toBe('accepted');
    expect(row(c).archiveRelPath).toBe('work/a/c.txt');
  });

  it('partially moved counts as executed', async () => {
    await archived('a.txt', 'Inhalt A', 'work/a');
    await archived('b.txt', 'Inhalt B', 'work/a');
    await archived('c.txt', 'Inhalt C', 'work/c');
    const d = await archived('d.txt', 'Inhalt D', 'work/d');
    await app.services.consistency.run('test');
    const insight = app.services.insights.list('open').find((i) => i.kind === 'scattered_documents')!;
    fs.appendFileSync(abs(d), ' – bearbeitet');

    await app.services.insights.accept(insight.id, {});

    expect(app.services.insights.get(insight.id).status).toBe('accepted');
    expect(app.services.actions.get(insight.recommendedActionId!).result).toMatch(/1 verschoben.*1 Konflikte/);
  });
});
