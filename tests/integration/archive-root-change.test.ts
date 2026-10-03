import fs from 'node:fs';
import path from 'node:path';
import type { Job } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const row = (id: string) => app.services.documents.getRow(id);
const absIn = (root: string, id: string) => path.join(root, ...row(id).archiveRelPath!.split('/'));
const newRoot = () => path.join(app.root, 'NAS', 'Archiv');

async function archived(name: string, content: string, loc = 'Arbeit/notes'): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: loc }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic: null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  expect(row(id).status).toBe('archived');
  return id;
}

/** Starts a move and waits for its background job; returns the finished job. */
async function migrate(to: string) {
  const res = await app.ok('archive:changeRoot', { root: to, mode: 'migrate', confirmed: true });
  expect(res.jobId).toBeTruthy();
  await app.services.jobs.whenIdle();
  return app.services.jobs.get(res.jobId!);
}

const undoLast = async () => {
  const status = await app.ok('archive:rootStatus', {});
  return app.ok('audit:undo', { auditId: status.lastChange!.auditId });
};

const notificationTitles = async () => (await app.ok('notifications:list', {})).map((n) => n.title);

describe('changing the archive root', () => {
  it('previews both ways without changing anything', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    await archived('b.txt', 'Inhalt B', 'Privat/b');
    const old = archiveRoot();

    const preview = await app.ok('archive:previewRootChange', { root: newRoot() });

    expect(preview).toMatchObject({ from: old, to: newRoot(), pathOnlyBlockers: [] });
    expect(preview.atTarget).toMatchObject({ documents: 2, present: 0, missing: 2, different: 0 });
    expect(preview.atTarget.examples).toHaveLength(2);
    expect(preview.migrate.blockers).toEqual([]);
    expect(preview.migrate.files).toBeGreaterThanOrEqual(2);
    expect(preview.migrate.bytes).toBeGreaterThanOrEqual('Inhalt A'.length + 'Inhalt B'.length);
    expect(fs.existsSync(newRoot()), 'the preview creates nothing').toBe(false);
    expect(archiveRoot()).toBe(old);
    expect(fs.existsSync(absIn(old, a))).toBe(true);
  });

  it('moves the archive: copies, verifies, switches and keeps the old folder', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const b = await archived('b.txt', 'Inhalt B', 'Privat/b');
    const old = archiveRoot();
    fs.writeFileSync(path.join(old, 'eigene-notiz.md'), 'nicht von Archivist');

    const job = await migrate(newRoot());

    expect(job.status).toBe('succeeded');
    expect(archiveRoot()).toBe(newRoot());
    for (const id of [a, b]) {
      expect(fs.readFileSync(absIn(newRoot(), id), 'utf8')).toBe(fs.readFileSync(absIn(old, id), 'utf8'));
      expect(fs.existsSync(absIn(old, id)), 'the old folder stays untouched').toBe(true);
    }
    expect(fs.readFileSync(path.join(newRoot(), 'eigene-notiz.md'), 'utf8'), 'untracked files move along').toBe('nicht von Archivist');
    expect(fs.readdirSync(newRoot(), { recursive: true }).some((f) => String(f).endsWith('.archivist-partial'))).toBe(false);

    const verify = await app.ok('archive:verify', {});
    expect(verify).toMatchObject({ ok: true, checkedDocuments: 2, missingFiles: [], changedFiles: [] });
    expect((await app.ok('documents:get', { id: a })).archivePath).toBe(absIn(newRoot(), a));
    await app.ok('app:openPath', { documentId: a });
    expect(app.host.opened.at(-1)).toBe(absIn(newRoot(), a));

    const status = await app.ok('archive:rootStatus', {});
    expect(status.current).toMatchObject({ documents: 2, present: 2, missing: 0 });
    expect(status.lastChange).toMatchObject({ from: old, to: newRoot(), mode: 'migrate', undoable: true });
    expect(await notificationTitles()).toContain('Archiv umgezogen');
  });

  it('keeps earlier archive actions undoable after the move', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const archiveAudit = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'archive.copy' && e.entityIds.includes(a))!;
    expect(archiveAudit).toBeTruthy();
    await migrate(newRoot());

    const res = await app.ok('audit:undo', { auditId: archiveAudit.id });

    expect(res.conflicts).toEqual([]);
    expect(res.undone).toBe(true);
    expect(row(a).archiveRelPath).toBeNull();
  });

  it('undoes a move: switches back and removes the unchanged copies', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();
    await migrate(newRoot());

    const res = await undoLast();

    expect(res).toMatchObject({ undone: true, conflicts: [] });
    expect(archiveRoot()).toBe(old);
    expect(fs.existsSync(absIn(old, a))).toBe(true);
    expect(fs.existsSync(newRoot()), 'the folder created by the move is removed again').toBe(false);
    expect((await app.ok('archive:verify', {})).ok).toBe(true);
  });

  it('refuses to undo a move when documents were archived into the new folder since', async () => {
    await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();
    await migrate(newRoot());
    const c = await archived('c.txt', 'Neu nach dem Umzug');
    expect(fs.existsSync(absIn(newRoot(), c))).toBe(true);

    const res = await undoLast();

    expect(res.undone).toBe(false);
    expect(res.conflicts.join(' ')).toMatch(/1 Dokument liegt nur im neuen Archivordner/);
    expect(archiveRoot()).toBe(newRoot());
    expect(fs.existsSync(absIn(old, c))).toBe(false);
  });

  it('refuses to undo a move when a file was changed in the new folder', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    await migrate(newRoot());
    fs.writeFileSync(absIn(newRoot(), a), 'geändert');

    const res = await undoLast();

    expect(res.undone).toBe(false);
    expect(res.conflicts.join(' ')).toMatch(/unterscheidet sich/);
    expect(archiveRoot()).toBe(newRoot());
  });

  it('never overwrites a different file in the target and copies nothing then', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();
    const rel = row(a).archiveRelPath!;
    fs.mkdirSync(path.dirname(path.join(newRoot(), rel)), { recursive: true });
    fs.writeFileSync(path.join(newRoot(), rel), 'fremde Datei mit anderem Inhalt');

    const preview = await app.ok('archive:previewRootChange', { root: newRoot() });
    expect(preview.atTarget.different).toBe(1);
    expect(preview.migrate.blockers.join(' ')).toMatch(/bereits andere Dateien/);
    const r = await app.call('archive:changeRoot', { root: newRoot(), mode: 'migrate', confirmed: true });

    expect(r.ok).toBe(false);
    expect(archiveRoot()).toBe(old);
    expect(fs.readFileSync(path.join(newRoot(), rel), 'utf8')).toBe('fremde Datei mit anderem Inhalt');
  });

  it('accepts identical files already in the target and leaves them on undo', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();
    fs.cpSync(old, newRoot(), { recursive: true });

    const preview = await app.ok('archive:previewRootChange', { root: newRoot() });
    expect(preview.migrate.alreadyPresent).toBe(preview.migrate.files);
    expect((await migrate(newRoot())).status).toBe('succeeded');
    expect(archiveRoot()).toBe(newRoot());

    expect((await undoLast()).undone).toBe(true);
    expect(fs.existsSync(absIn(newRoot(), a)), 'files that were already there are not removed').toBe(true);
  });

  it('refuses nested folders and the current folder', async () => {
    await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();
    const inside = await app.ok('archive:previewRootChange', { root: path.join(old, 'neu') });
    expect(inside.migrate.blockers.join(' ')).toMatch(/innerhalb des bisherigen/);
    const outside = await app.ok('archive:previewRootChange', { root: path.dirname(old) });
    expect(outside.migrate.blockers.join(' ')).toMatch(/liegt innerhalb des neuen Ordners/);
    const same = await app.ok('archive:previewRootChange', { root: old });
    expect(same.pathOnlyBlockers.join(' ')).toMatch(/derselbe/);
    const relative = await app.call('archive:previewRootChange', { root: 'relativ/archiv' });
    expect(relative.ok).toBe(false);
  });

  it('path only: switches when the files are already there, and is undoable', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();
    fs.cpSync(old, newRoot(), { recursive: true });

    const res = await app.ok('archive:changeRoot', { root: newRoot(), mode: 'pathOnly', confirmed: true });

    expect(res).toMatchObject({ mode: 'pathOnly', jobId: null, unreachable: 0 });
    expect(archiveRoot()).toBe(newRoot());
    expect((await app.ok('archive:verify', {})).ok).toBe(true);
    expect((await undoLast()).undone).toBe(true);
    expect(archiveRoot()).toBe(old);
    expect(fs.existsSync(absIn(newRoot(), a)), 'path only never deletes files').toBe(true);
  });

  it('path only: refuses without explicit acceptance when documents are missing', async () => {
    await archived('a.txt', 'Inhalt A');
    await archived('b.txt', 'Inhalt B');
    const old = archiveRoot();

    const r = await app.call('archive:changeRoot', { root: newRoot(), mode: 'pathOnly', confirmed: true });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/fehlen 2 von 2 archivierten Dokumenten/);
    expect(archiveRoot()).toBe(old);
  });

  it('path only with accepted warning: switches, warns with the number of affected documents', async () => {
    await archived('a.txt', 'Inhalt A');
    await archived('b.txt', 'Inhalt B');

    const res = await app.ok('archive:changeRoot', { root: newRoot(), mode: 'pathOnly', confirmed: true, acceptMissing: true });

    expect(res.unreachable).toBe(2);
    expect(archiveRoot()).toBe(newRoot());
    expect(await notificationTitles()).toContain('2 archivierte Dokumente nicht erreichbar');
    expect((await app.ok('archive:rootStatus', {})).current).toMatchObject({ documents: 2, missing: 2 });
  });

  it('refuses a direct path change through the settings while archived documents exist', async () => {
    const a = await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();

    const r = await app.call('settings:update', { archiveRoot: newRoot(), llm: { timeoutMs: 45_000 } });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('archive_conflict');
      expect(r.error.message).toMatch(/1 archiviertes Dokument.*„Archiv umziehen“ oder „Nur Pfad ändern“/);
    }
    const settings = app.services.settings.get();
    expect(settings.archiveRoot, 'the settings stay unchanged, also the other fields of the patch').toBe(old);
    expect(settings.llm.timeoutMs).not.toBe(45_000);
    expect(fs.existsSync(newRoot()), 'the refused folder is not even created').toBe(false);
    expect(fs.existsSync(absIn(old, a))).toBe(true);
  });

  it('allows a direct path change through the settings while no document is archived', async () => {
    const res = await app.ok('settings:update', { archiveRoot: newRoot() });

    expect(res.settings.archiveRoot).toBe(newRoot());
    expect(archiveRoot()).toBe(newRoot());
    expect(fs.existsSync(newRoot())).toBe(true);
  });

  it('keeps accepting the unchanged archive path and other settings while documents are archived', async () => {
    await archived('a.txt', 'Inhalt A');
    const old = archiveRoot();

    const res = await app.ok('settings:update', { archiveRoot: `${old}${path.sep}`, llm: { timeoutMs: 45_000 } });

    expect(res.settings).toMatchObject({ archiveRoot: old, llm: { timeoutMs: 45_000 } });
    await app.ok('settings:update', { notifications: { reminderTime: '07:30' } });
    expect(archiveRoot()).toBe(old);
  });

  it('blocks archive file operations while the root is being changed', async () => {
    await archived('a.txt', 'Inhalt A');
    const imp = await app.ok('documents:import', { paths: [app.file('in/c.txt', 'Inhalt C')] });
    await app.services.jobs.whenIdle();
    const release = app.services.archive.beginRootChange();
    try {
      const r = await app.call('documents:archive', {
        items: [{ documentId: imp.imported[0]!.id, mode: 'copy', categoryPath: 'Arbeit/notes', topic: null }],
        confirmed: true,
        approveNewCategories: [],
        confirmMove: false,
      } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/gerade umgestellt/);
      const second = await app.call('archive:changeRoot', { root: newRoot(), mode: 'migrate', confirmed: true });
      expect(second.ok).toBe(false);
    } finally {
      release();
    }
  });

  it('cancelling a running move removes the copies made so far and keeps the old root', async () => {
    for (let i = 0; i < 4; i += 1) await archived(`n${i}.txt`, `Inhalt ${i}`);
    const old = archiveRoot();
    const onJob = (job: Job) => {
      if (job.status === 'running' && !job.cancelRequested && job.progressMessage?.startsWith('Kopiere und prüfe Datei 3')) app.services.jobs.cancel(job.id);
    };
    app.services.events.on('job:updated', onJob);
    try {
      const res = await app.ok('archive:changeRoot', { root: newRoot(), mode: 'migrate', confirmed: true });
      await app.services.jobs.whenIdle();

      expect(app.services.jobs.get(res.jobId!).status).toBe('cancelled');
    } finally {
      app.services.events.off('job:updated', onJob);
    }
    expect(archiveRoot()).toBe(old);
    expect(fs.existsSync(newRoot()), 'copies and created folders are removed again').toBe(false);
    expect(await notificationTitles()).toContain('Archivumzug abgebrochen');
    expect((await app.ok('archive:verify', {})).ok).toBe(true);
  });
});
