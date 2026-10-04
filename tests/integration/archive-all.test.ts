import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveMaintenance } from '../../packages/core/src/services/archive-maintenance';
import { inInbox } from '../helpers/agent';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto', scanEnabled: true });
});
afterEach(async () => app.cleanup());

const jobOf = () => app.services.jobs.list().find((job) => job.type === 'archive.all')!;
const statuses = async () => (await app.ok('documents:list', {})).map((document) => document.status);
const archiveAll = async (source: 'inbox' | 'scan' = 'inbox', extra: Record<string, unknown> = {}) => {
  const { previewId } = await app.ok('documents:archiveAllPreview', { source });
  return app.ok('documents:archiveAll', { previewId, confirmed: true, approveNewCategories: [], ...extra } as never);
};

async function fillInbox(count: number) {
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1)
    ids.push(await inInbox(app, { name: `brief${n}.txt`, content: `Brief ${n} mit ausreichend Text für die Analyse.`, folder: `Privat/ordner${n % 2}` }));
  return ids;
}

describe('„Alle Vorschläge archivieren“ (#228)', () => {
  it('previews the count and the target structure without changing anything', async () => {
    await fillInbox(4);

    const preview = await app.ok('documents:archiveAllPreview', { source: 'inbox' });

    expect(preview).toMatchObject({ count: 4, blocked: 0, moreFolders: 0 });
    expect(preview.folders.map((folder) => folder.count).reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(preview.folders.map((folder) => folder.path).sort()).toEqual(['Privat/ordner0', 'Privat/ordner1']);
    expect(await statuses()).toEqual(['proposed', 'proposed', 'proposed', 'proposed']);
  });

  it('needs the confirmation in the schema, not only in the UI', async () => {
    await fillInbox(1);
    const { previewId } = await app.ok('documents:archiveAllPreview', { source: 'inbox' });

    for (const confirmed of [false, undefined, 'true'])
      expect(await app.call('documents:archiveAll', { previewId, confirmed } as never)).toMatchObject({ ok: false });

    expect(app.services.jobs.list().filter((job) => job.type === 'archive.all')).toHaveLength(0);
    expect(await statuses()).toEqual(['proposed']);
  });

  it('archives every proposal as a copy in one job, leaves the originals and logs and undoes each document separately', async () => {
    const ids = await fillInbox(4);
    const originals = (await app.ok('documents:list', {})).map((document) => document.sourcePath!).filter(Boolean);

    await archiveAll();
    await app.services.jobs.whenIdle();

    expect(jobOf()).toMatchObject({ status: 'succeeded', summary: '4 archiviert, 0 übersprungen, 0 fehlgeschlagen, 0 Konflikte.' });
    expect(await statuses()).toEqual(['archived', 'archived', 'archived', 'archived']);
    for (const original of originals) expect(fs.existsSync(original)).toBe(true);
    const audits = (await app.ok('audit:list', {})).filter((entry) => entry.action === 'archive.copy');
    expect(audits).toHaveLength(4);
    expect(app.services.notifications.list().filter((notification) => notification.title === 'Archivierung abgeschlossen')).toHaveLength(1);

    const undone = await app.ok('audit:undo', { auditId: audits[0]!.id });
    expect(undone.undone).toBe(true);
    expect((await statuses()).filter((status) => status === 'archived')).toHaveLength(3);
    expect(ids).toHaveLength(4);
  });

  it('never overwrites: a file already at the target stays, the document gets another name', async () => {
    const [id] = await fillInbox(1);
    const target = path.join(app.services.settings.get().archiveRoot, 'Privat', 'ordner1');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'brief1.txt'), 'bereits da');

    await archiveAll();
    await app.services.jobs.whenIdle();

    expect(fs.readFileSync(path.join(target, 'brief1.txt'), 'utf8')).toBe('bereits da');
    expect((await app.ok('documents:get', { id: id! })).status).toBe('archived');
  });

  it('works through the batches and continues after its checkpoint without archiving twice', async () => {
    const ids = await fillInbox(3);
    await app.services.jobs.stop();
    const { jobId } = await archiveAll();
    app.services.database.sqlite
      .prepare('UPDATE jobs SET result = ? WHERE id = ?')
      .run(JSON.stringify({ checkpoint: { next: 3, success: 3, skipped: 0, failed: 0, conflicts: 0 } }), jobId);
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(jobOf().summary).toBe('3 archiviert, 0 übersprungen, 0 fehlgeschlagen, 0 Konflikte.');
    expect(await statuses()).toEqual(['proposed', 'proposed', 'proposed']);
    expect(ids).toHaveLength(3);
  });

  it('takes only the documents of the scan’s assignment groups for the source „scan“', async () => {
    await fillInbox(2);
    app.file('Downloads/scan.txt', 'Ein gescanntes Dokument mit ausreichend Text für die Analyse.');
    app.llm.on('DocumentClassification', () => classification({ title: 'Gescannt', summary: 'Gescannt.', categoryPath: 'Privat/gescannt' }));
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const file = app.services.scanner.getResults({}).files.find((f) => f.name === 'scan.txt')!;
    await app.ok('scanner:analyze', { fileIds: [file.id], confirmLlm: true });
    await app.services.jobs.whenIdle();

    expect(await app.ok('documents:archiveAllPreview', { source: 'scan' })).toMatchObject({ count: 1 });
    await archiveAll('scan');
    await app.services.jobs.whenIdle();

    const documents = await app.ok('documents:list', {});
    expect(documents.filter((document) => document.status === 'archived').map((document) => document.originalName)).toEqual(['scan.txt']);
    expect(documents.filter((document) => document.status === 'proposed')).toHaveLength(2);
  });

  it('can be cancelled between batches', async () => {
    await fillInbox(2);
    await app.services.jobs.stop();
    const { jobId } = await archiveAll();
    app.services.jobs.cancel(jobId);
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(jobOf().status).toBe('cancelled');
    expect(await statuses()).toEqual(['proposed', 'proposed']);
  });
});

describe('„Alle Vorschläge archivieren“ archives what the preview showed (#228)', () => {
  it('creates a new main category only when it is approved; the other documents become conflicts', async () => {
    await fillInbox(1);
    await inInbox(app, { name: 'neu.txt', content: 'Ein Dokument für eine neue Hauptkategorie mit genug Text.', folder: 'neuekategorie/unter' });
    const root = app.services.settings.get().archiveRoot;

    const preview = await app.ok('documents:archiveAllPreview', { source: 'inbox' });
    expect(preview.newCategories).toContain('neuekategorie');
    await archiveAll('inbox', { approveNewCategories: [] });
    await app.services.jobs.whenIdle();

    expect(fs.existsSync(path.join(root, 'neuekategorie'))).toBe(false);
    expect(jobOf().summary).toMatch(/\d+ Konflikte?/);
    expect(jobOf().summary).not.toContain(' 0 Konflikte');
    expect((await statuses()).filter((status) => status === 'proposed').length).toBeGreaterThan(0);
  });

  it('creates the approved main category', async () => {
    await inInbox(app, { name: 'neu.txt', content: 'Ein Dokument für eine neue Hauptkategorie mit genug Text.', folder: 'neuekategorie/unter' });

    await archiveAll('inbox', { approveNewCategories: ['neuekategorie'] });
    await app.services.jobs.whenIdle();

    expect(fs.existsSync(path.join(app.services.settings.get().archiveRoot, 'neuekategorie', 'unter', 'neu.txt'))).toBe(true);
    expect(jobOf().summary).toBe('1 archiviert, 0 übersprungen, 0 fehlgeschlagen, 0 Konflikte.');
  });

  it('archives only the previewed documents and skips those that stopped being proposals since', async () => {
    const [first, second] = await fillInbox(2);
    const { previewId } = await app.ok('documents:archiveAllPreview', { source: 'inbox' });
    await inInbox(app, { name: 'spaeter.txt', content: 'Kam nach der Vorschau dazu, mit genug Text für die Analyse.', folder: 'Privat/spaeter' });
    await app.ok('documents:archive', {
      items: [{ documentId: first!, mode: 'ignore' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    } as never);

    await app.ok('documents:archiveAll', { previewId, confirmed: true, approveNewCategories: [] });
    await app.services.jobs.whenIdle();

    expect(jobOf().summary).toBe('1 archiviert, 1 übersprungen, 0 fehlgeschlagen, 0 Konflikte.');
    expect((await app.ok('documents:get', { id: second! })).status).toBe('archived');
    expect((await statuses()).filter((status) => status === 'proposed')).toHaveLength(1);
  });

  it('refuses an unknown preview and returns the queued job for a second confirmation of the same preview', async () => {
    await fillInbox(1);
    await app.services.jobs.stop();
    const { previewId } = await app.ok('documents:archiveAllPreview', { source: 'inbox' });
    const confirm: { confirmed: true; approveNewCategories: string[] } = { confirmed: true, approveNewCategories: [] };

    expect(await app.call('documents:archiveAll', { previewId: 'gibt-es-nicht', ...confirm })).toMatchObject({ ok: false });
    const first = await app.ok('documents:archiveAll', { previewId, ...confirm });
    const second = await app.ok('documents:archiveAll', { previewId, ...confirm });

    expect(second.jobId).toBe(first.jobId);
    expect(app.services.jobs.list().filter((job) => job.type === 'archive.all')).toHaveLength(1);
  });

  it('keeps the progress and reports when it is cancelled mid-run, so a retry does not replay the batch', async () => {
    await fillInbox(2);
    const execute = app.services.archive.execute.bind(app.services.archive);
    vi.spyOn(app.services.archive, 'execute').mockImplementationOnce(async (items, options) => {
      const result = await execute(items, options);
      app.services.jobs.cancel(jobOf().id);
      return result;
    });

    await archiveAll();
    await app.services.jobs.whenIdle();

    expect(jobOf().status).toBe('cancelled');
    const notice = app.services.notifications.list().find((notification) => notification.title === 'Archivierung abgebrochen');
    expect(notice?.description).toContain('2 archiviert, 0 übersprungen');

    app.services.jobs.retry(jobOf().id);
    await app.services.jobs.whenIdle();

    expect(jobOf()).toMatchObject({ status: 'succeeded', summary: '2 archiviert, 0 übersprungen, 0 fehlgeschlagen, 0 Konflikte.' });
  });

  it('cleans the inbox once at the end of the run instead of before every batch', async () => {
    await fillInbox(2);
    const cleanup = vi.spyOn(ArchiveMaintenance.prototype, 'cleanupInbox');
    const options = { confirmed: true, approveNewCategories: [], confirmMove: false };

    await app.services.archive.execute([], { ...options, inboxCleanup: 'later' });
    expect(cleanup).not.toHaveBeenCalled();
    await app.services.archive.execute([], options);
    expect(cleanup).toHaveBeenCalledTimes(1);
    cleanup.mockClear();
    await archiveAll();
    await app.services.jobs.whenIdle();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
