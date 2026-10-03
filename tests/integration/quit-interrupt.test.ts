import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPTED_JOB_MESSAGE, isJobCancelled, isJobInterrupted, JobQueueService } from '../../packages/core/src/services/jobs';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

const apps: TestApp[] = [];
const queues: JobQueueService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const q of queues.splice(0)) await q.interrupt(0);
  for (const a of apps.splice(0)) await a.cleanup();
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newApp(dataRoot?: string): Promise<TestApp> {
  const app = await createTestApp({ privacy: 'auto', dataRoot });
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Klassifiziert', summary: 'Zusammenfassung', categoryPath: 'work/notes', mainTopic: 'Test' }),
  );
  return app;
}

/** A separate queue on a test app's database (the app's own queue is paused so it does not pick up these jobs). */
async function makeQueue(): Promise<{ app: TestApp; q: JobQueueService }> {
  const app = await newApp();
  apps.push(app);
  await app.services.jobs.stop();
  const q = new JobQueueService(app.services.ctx, { concurrency: 1, retryBaseDelayMs: 0 });
  queues.push(q);
  return { app, q };
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(5);
  }
}

describe('Job queue on quit', () => {
  it('interrupts running jobs without using up an attempt and resumes them after the restart', async () => {
    const { app, q } = await makeQueue();
    const onCancelled = vi.fn();
    const onFailed = vi.fn();
    q.register('test.cooperative', {
      handler: async (job) => {
        await new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve(), { once: true }));
        job.throwIfCancelled();
        return 'nie';
      },
      hooks: { onCancelled, onFailed },
    });
    q.start();
    const job = q.enqueue('test.cooperative', { label: 'Kooperativ' });
    const waiting = q.enqueue('test.cooperative', { label: 'Wartet', payload: {}, maxAttempts: 1 });
    await waitFor(() => q.get(job.id).status === 'running');

    const res = await q.interrupt(2_000);
    expect(res).toEqual({ interrupted: 1, unfinished: 0 });
    expect(q.get(waiting.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(q.get(job.id)).toMatchObject({ status: 'pending', attempts: 0, cancelRequested: false });
    expect(q.get(job.id).progressMessage).toBe(INTERRUPTED_JOB_MESSAGE);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();

    // next start (a new queue on the same database, like after a restart)
    const q2 = new JobQueueService(app.services.ctx, { concurrency: 1 });
    queues.push(q2);
    q2.register('test.cooperative', { handler: async () => 'fertig' });
    q2.start();
    await q2.whenIdle();
    expect(q2.get(job.id).status).toBe('succeeded');
    expect(q2.get(waiting.id).status).toBe('succeeded');
  });

  it('waits at most the given time for jobs that ignore the signal', async () => {
    const { app, q } = await makeQueue();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const onFailed = vi.fn();
    q.register('test.stubborn', {
      handler: async (job) => {
        job.report(0.3, 'zäh');
        await gate;
        job.report(0.9, 'nach dem Beenden'); // ignored: the job was given up
        throw new Error('Worker-Pool beendet');
      },
      hooks: { onFailed },
    });
    q.start();
    const job = q.enqueue('test.stubborn', { label: 'Stur', payload: {}, maxAttempts: 1 });
    await waitFor(() => q.get(job.id).status === 'running');

    const t0 = Date.now();
    const res = await q.interrupt(40);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res).toEqual({ interrupted: 1, unfinished: 1 });
    expect(q.get(job.id)).toMatchObject({ status: 'pending', attempts: 0, progressMessage: INTERRUPTED_JOB_MESSAGE });

    finish();
    await delay(30);
    // whatever the abandoned handler does afterwards is not recorded
    expect(q.get(job.id)).toMatchObject({ status: 'pending', attempts: 0, progressMessage: INTERRUPTED_JOB_MESSAGE, error: null });
    expect(onFailed).not.toHaveBeenCalled();

    const q2 = new JobQueueService(app.services.ctx, { concurrency: 1 });
    queues.push(q2);
    q2.register('test.stubborn', { handler: async () => 'fertig' });
    q2.start();
    await q2.whenIdle();
    expect(q2.get(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('does not count errors after the interruption as a failure', async () => {
    const { q } = await makeQueue();
    const onFailed = vi.fn();
    let thrown: unknown;
    q.register('test.aborting', {
      handler: async (job) => {
        await new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve(), { once: true }));
        try {
          job.signal.throwIfAborted();
        } catch (err) {
          thrown = err;
        }
        throw new Error('Die LLM-Anfrage wurde abgebrochen.');
      },
      hooks: { onFailed },
    });
    q.start();
    const job = q.enqueue('test.aborting', { label: 'Abbruch', payload: {}, maxAttempts: 1 });
    await waitFor(() => q.get(job.id).status === 'running');
    await q.interrupt(2_000);
    expect(isJobInterrupted(thrown)).toBe(true);
    expect(isJobCancelled(thrown)).toBe(true);
    expect(q.get(job.id)).toMatchObject({ status: 'pending', error: null });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('leaves a previously cancelled job cancelled', async () => {
    const { q } = await makeQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.register('test.long', {
      handler: async (job) => {
        await gate;
        job.throwIfCancelled();
      },
    });
    q.start();
    const job = q.enqueue('test.long', { label: 'Lang' });
    await waitFor(() => q.get(job.id).status === 'running');
    q.cancel(job.id);
    const stopping = q.interrupt(2_000);
    release();
    await stopping;
    expect(q.get(job.id).status).toBe('cancelled');
  });
});

describe('Quitting the application during an analysis', () => {
  it('quits promptly and continues analysing the document after the restart', async () => {
    const app = await newApp();
    const src = app.file('in/gross.txt', 'Ein großes Dokument, dessen Analyse beim Beenden unterbrochen wird.');
    const pool = app.services.pool;
    const original = pool.run.bind(pool);
    vi.spyOn(pool, 'run').mockImplementation(async (task, payload) => {
      if (task === 'extractDocument') await delay(300); // a long extraction (e.g. OCR) that ignores the signal
      return original(task, payload);
    });
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await waitFor(() => app.services.jobs.list().some((j) => j.type === 'document.analyze' && j.status === 'running'));

    const t0 = Date.now();
    await app.services.shutdown({ jobTimeoutMs: 30 });
    expect(Date.now() - t0).toBeLessThan(250);
    await delay(350); // the abandoned analysis ends meanwhile and must not touch anything

    const app2 = await newApp(app.root);
    apps.push(app2);
    // the document is still `analyzing`, but covered by its resumed job – not marked as failed
    expect(app2.services.documents.recoverInterruptedAnalyses()).toBe(0);
    await app2.services.jobs.whenIdle();
    const job = app2.services.jobs.list().find((j) => j.type === 'document.analyze')!;
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1 });
    const doc = await app2.ok('documents:get', { id });
    expect(doc.status).not.toBe('failed');
    expect(doc.status).not.toBe('analyzing');
    expect(doc.title).toBe('Klassifiziert');
    expect(app2.services.notifications.list().filter((n) => n.type === 'import_failed')).toEqual([]);
    expect(fs.existsSync(src)).toBe(true);
  });

  it('aborts a cooperative analysis without marking the document as cancelled', async () => {
    const app = await newApp();
    const src = app.file('in/kurz.txt', 'Dokument, dessen Analyse beim Beenden am nächsten Prüfpunkt endet.');
    const pool = app.services.pool;
    const original = pool.run.bind(pool);
    vi.spyOn(pool, 'run').mockImplementation(async (task, payload) => {
      if (task === 'extractDocument') await delay(80);
      return original(task, payload);
    });
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await waitFor(() => app.services.jobs.list().some((j) => j.type === 'document.analyze' && j.status === 'running'));
    expect(await app.services.jobs.interrupt(2_000)).toEqual({ interrupted: 1, unfinished: 0 });
    const job = app.services.jobs.list().find((j) => j.type === 'document.analyze')!;
    expect(job).toMatchObject({ status: 'pending', attempts: 0, progressMessage: INTERRUPTED_JOB_MESSAGE });
    expect((await app.ok('documents:get', { id })).status).toBe('analyzing');
    await app.services.shutdown({ jobTimeoutMs: 2_000 });

    const app2 = await newApp(app.root);
    apps.push(app2);
    await app2.services.jobs.whenIdle();
    expect(app2.services.jobs.get(job.id).status).toBe('succeeded');
  });
});
