import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documents } from '../../packages/core/src/db/schema';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Neu klassifiziert', summary: 'Zusammenfassung', categoryPath: 'work/neu', mainTopic: 'Test' }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const archive = (documentId: string, mode: 'copy' | 'move' | 'index_only') =>
  app.ok('documents:archive', {
    items: [{ documentId, mode, categoryPath: 'work/notes' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: mode === 'move',
  } as never);

/** Imports a file while the job queue is paused, so its analysis job stays queued. */
async function importQueued(name: string, content: string) {
  await app.services.jobs.stop();
  const src = app.file(`in/${name}`, content);
  const imp = await app.ok('documents:import', { paths: [src] });
  const id = imp.imported[0]!.id;
  expect((await app.ok('documents:get', { id })).status).toBe('staged');
  return { src, id };
}

const analyzeJobs = () => app.services.jobs.list().filter((j) => j.type === 'document.analyze');

/** Makes text extraction fail (or run a hook first) for the next extraction only. */
function interceptExtraction(hook: () => Promise<void>) {
  const pool = app.services.pool;
  const original = pool.run.bind(pool);
  let fired = false;
  return vi.spyOn(pool, 'run').mockImplementation(async (task, payload) => {
    if (task === 'extractDocument' && !fired) {
      fired = true;
      await hook();
    }
    return original(task, payload);
  });
}

describe('Analysis does not reopen archived documents', () => {
  it('regression: archive, then the queued analysis runs – the status stays "archived"', async () => {
    const { id } = await importQueued('notiz.txt', 'Eine Notiz mit ausreichend Inhalt für die Analyse.');
    const res = await archive(id, 'copy');
    const archived = await app.ok('documents:get', { id });
    expect(archived.status).toBe('archived');

    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    const after = await app.ok('documents:get', { id });
    expect(after.status).toBe('archived');
    expect(after.archiveRelPath).toBe(archived.archiveRelPath);
    expect(after.title).toBe(archived.title);
    expect(after.categoryPath).toBe('work/notes');
    expect(analyzeJobs()[0]!.status).toBe('succeeded');
    // no second archiving possible
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: id, mode: 'copy' }] });
    expect(plan.items[0]!.blocked).toBe(true);
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(true);
    expect(fs.readdirSync(path.dirname(res.items[0]!.targetPath!))).toHaveLength(1);
  });

  it('after "Verschieben" the queued analysis neither fails nor sets "failed"', async () => {
    const { id } = await importQueued('verschoben.txt', 'Diese Datei wird ins Archiv verschoben, bevor die Analyse läuft.');
    await archive(id, 'move');
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    const after = await app.ok('documents:get', { id });
    expect(after.status).toBe('archived');
    expect(after.processingError).toBeNull();
    expect(analyzeJobs()[0]!.status).toBe('succeeded');
  });

  it('leaves only indexed documents unchanged', async () => {
    const { id } = await importQueued('index.txt', 'Nur indexiert, nicht kopiert, mit etwas Inhalt.');
    await archive(id, 'index_only');
    app.services.jobs.start();
    await app.services.jobs.whenIdle();
    expect((await app.ok('documents:get', { id })).status).toBe('indexed_only');
  });

  it('discards the result when the document was archived during the running analysis', async () => {
    const src = app.file('in/rennen.txt', 'Dokument, das während der Analyse archiviert wird.');
    let id = '';
    interceptExtraction(async () => {
      await archive(id, 'copy');
    });
    await app.services.jobs.stop();
    id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    const after = await app.ok('documents:get', { id });
    expect(after.status).toBe('archived');
    expect(after.categoryPath).toBe('work/notes');
    expect(after.title).not.toBe('Neu klassifiziert');
    expect(analyzeJobs()[0]!.status).toBe('succeeded');
  });

  it('rejects reprocessing of archived documents', async () => {
    const { id } = await importQueued('fertig.txt', 'Schon archiviertes Dokument mit Inhalt.');
    await archive(id, 'copy');
    const r = await app.call('documents:classify', { documentId: id, allowLlm: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/nicht erneut analysiert/);
  });
});

describe('A failed analysis does not block a document', () => {
  it('sets "failed" with a reason on a scanner error and allows "Erneut verarbeiten"', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    const dl = path.join(app.home, 'Downloads');
    app.file('Downloads/scan.txt', 'Gescannte Datei mit ausreichend Inhalt für die Analyse.');
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const file = (await app.ok('scanner:getResults', {})).files.find((f) => f.name === 'scan.txt')!;

    const spy = interceptExtraction(async () => {
      throw new Error('Parser abgestürzt');
    });
    await app.ok('scanner:analyze', { fileIds: [file.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    spy.mockRestore();

    const failed = (await app.ok('documents:list', { status: 'failed' })).find((d) => d.originalName === 'scan.txt');
    expect(failed).toBeDefined();
    expect(failed!.processingError).toMatch(/Parser abgestürzt/);
    expect(await app.ok('documents:list', { status: 'analyzing' })).toHaveLength(0);

    await app.ok('documents:classify', { documentId: failed!.id, allowLlm: true });
    await app.services.jobs.whenIdle();
    expect((await app.ok('documents:get', { id: failed!.id })).status).toBe('proposed');
  });

  it('sets "failed" with a reason on an error in the analysis job and notifies', async () => {
    interceptExtraction(async () => {
      throw new Error('Parser abgestürzt');
    });
    const src = app.file('in/kaputt.txt', 'Inhalt, dessen Extraktion fehlschlägt.');
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await app.services.jobs.whenIdle();

    const d = await app.ok('documents:get', { id });
    expect(d.status).toBe('failed');
    expect(d.processingError).toMatch(/Analyse fehlgeschlagen: Parser abgestürzt/);
    expect(app.services.notifications.list().some((n) => n.type === 'import_failed' && n.affectedEntityIds.includes(id))).toBe(true);
  });
});

describe('Startup cleanup of orphaned analyses', () => {
  it('sets documents in "analyzing" without a running job to "failed"; those with a queued job stay', async () => {
    const orphan = await importQueued('verwaist.txt', 'Dokument, dessen Analyse beim Beenden unterbrochen wurde.');
    const queued = await importQueued('wartend.txt', 'Dokument, dessen Analyse nach dem Neustart fortgesetzt wird.');
    app.services.database.db.update(documents).set({ status: 'analyzing' }).run();
    // the orphan's job is gone (e.g. finished as failed in an earlier session)
    const orphanJob = analyzeJobs().find((j) => j.label.includes('verwaist.txt'))!;
    app.services.database.sqlite.prepare("update jobs set status = 'failed' where id = ?").run(orphanJob.id);

    expect(app.services.documents.recoverInterruptedAnalyses()).toBe(1);
    const o = await app.ok('documents:get', { id: orphan.id });
    expect(o.status).toBe('failed');
    expect(o.processingError).toMatch(/unterbrochen/);
    expect((await app.ok('documents:get', { id: queued.id })).status).toBe('analyzing');

    app.services.jobs.start();
    await app.services.jobs.whenIdle();
    expect((await app.ok('documents:get', { id: queued.id })).status).toBe('proposed');
    expect((await app.ok('documents:get', { id: orphan.id })).status).toBe('failed');
  });
});
