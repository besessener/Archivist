import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobQueueService, retryDelayMs } from '../../packages/core/src/services/jobs';
import { AppError, fsError } from '../../packages/core/src/util/errors';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
let queues: JobQueueService[] = [];

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Klassifiziert', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes', mainTopic: 'Test' }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const q of queues) await q.stop();
  queues = [];
  await app.cleanup();
});

/** A separate queue on the test app's database (the app's own queue is paused so it does not pick up these jobs). */
async function makeQueue(retryBaseDelayMs: number): Promise<JobQueueService> {
  await app.services.jobs.stop();
  const q = new JobQueueService(app.services.ctx, { concurrency: 1, retryBaseDelayMs, retryMaxDelayMs: 10_000 });
  queues.push(q);
  return q;
}

const transient = () => fsError('Datei ist gesperrt.', { retryable: true });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const analyzeJob = () => app.services.jobs.list().find((j) => j.type === 'document.analyze')!;
const analyzedDocId = () => app.services.jobs.activePayloads<{ documentId: string }>('document.analyze')[0]!.documentId;
const importFailures = (id: string) => app.services.notifications.list().filter((n) => n.type === 'import_failed' && n.affectedEntityIds.includes(id));

/** Lets text extraction fail with `error` for the first `times` extractions. */
function failExtraction(times: number, error: () => Error, before?: () => void) {
  const pool = app.services.pool;
  const original = pool.run.bind(pool);
  let calls = 0;
  return vi.spyOn(pool, 'run').mockImplementation(async (task, payload) => {
    if (task === 'extractDocument') {
      calls += 1;
      before?.();
      if (calls <= times) throw error();
    }
    return original(task, payload);
  });
}

describe('Retry with backoff', () => {
  it('computes the backoff exponentially and caps it', () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, { baseMs: 1000, maxMs: 60_000 }))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(10, { baseMs: 1000, maxMs: 60_000 })).toBe(60_000);
    expect(retryDelayMs(0, { baseMs: 1000, maxMs: 60_000 })).toBe(1000);
  });

  it('waits increasingly longer before each further attempt and reports the failure only after the last attempt', async () => {
    const q = await makeQueue(40);
    const startedAt: number[] = [];
    const onFailed = vi.fn();
    q.register('test.transient', {
      handler: async () => {
        startedAt.push(Date.now());
        throw transient();
      },
      hooks: { onFailed },
    });
    q.start();
    const job = q.enqueue('test.transient', { label: 'Vorübergehend' });

    await tick(15);
    const waiting = q.get(job.id);
    expect(waiting.status).toBe('pending');
    expect(waiting.attempts).toBe(1);
    expect(waiting.error).toMatch(/gesperrt/);
    expect(waiting.progressMessage).toMatch(/Neuer Versuch in \d+ s \(Versuch 2 von 3\)/);
    expect(onFailed).not.toHaveBeenCalled();

    await q.whenIdle(5_000);
    expect(startedAt).toHaveLength(3);
    const gaps = [startedAt[1]! - startedAt[0]!, startedAt[2]! - startedAt[1]!];
    expect(gaps[0]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(75);
    expect(q.get(job.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ id: job.id, attempts: 3 });
  });

  it('loses no retry that becomes due while the queue is looking for work', async () => {
    // Each clock reading adds 1 ms, so the retry falls due between the queue's due check and its timer decision.
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock++);
    for (let retryBaseDelayMs = 1; retryBaseDelayMs <= 8; retryBaseDelayMs += 1) {
      const q = await makeQueue(retryBaseDelayMs);
      let calls = 0;
      q.register('test.flaky', {
        handler: async () => {
          calls += 1;
          if (calls === 1) throw transient();
          return 'ok';
        },
      });
      q.start();
      const job = q.enqueue('test.flaky', { label: `Wartezeit ${retryBaseDelayMs} ms` });
      await vi.waitFor(() => expect(q.get(job.id)).toMatchObject({ status: 'succeeded', attempts: 2 }), { timeout: 2_000, interval: 5 });
      await q.stop();
    }
  });

  it('does not retry permanent errors and reports them immediately', async () => {
    const q = await makeQueue(40);
    const onFailed = vi.fn();
    let calls = 0;
    q.register('test.permanent', {
      handler: async () => {
        calls += 1;
        throw new AppError('validation_error', 'Ungültig');
      },
      hooks: { onFailed },
    });
    q.start();
    const job = q.enqueue('test.permanent', { label: 'Dauerhaft' });
    await q.whenIdle(5_000);
    expect(calls).toBe(1);
    expect(q.get(job.id).status).toBe('failed');
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('cancels a job waiting for its retry without starting it again', async () => {
    const q = await makeQueue(60_000);
    const onCancelled = vi.fn();
    const onFailed = vi.fn();
    let calls = 0;
    q.register('test.transient', {
      handler: async () => {
        calls += 1;
        throw transient();
      },
      hooks: { onCancelled, onFailed },
    });
    q.start();
    const job = q.enqueue('test.transient', { label: 'Wartet auf Wiederholung' });
    await tick();
    expect(q.get(job.id).status).toBe('pending');

    expect(q.cancel(job.id).status).toBe('cancelled');
    await q.whenIdle(1_000);
    expect(calls).toBe(1);
    expect(onCancelled).toHaveBeenCalledWith({ id: job.id, payload: {} });
    expect(onFailed).not.toHaveBeenCalled();

    // a manual retry starts right away again (no leftover wait)
    q.register('test.transient', { handler: async () => 'ok' });
    q.retry(job.id);
    await q.whenIdle(1_000);
    expect(q.get(job.id).status).toBe('succeeded');
  });
});

describe('Cancelling', () => {
  it('aborts the signal of a running job; the job ends as "cancelled"', async () => {
    const q = await makeQueue(0);
    const onCancelled = vi.fn();
    q.register('test.wait', {
      handler: (job) =>
        new Promise((_resolve, reject) => {
          job.signal.addEventListener('abort', () => reject(new Error('Anfrage abgebrochen')), { once: true });
        }),
      hooks: { onCancelled },
    });
    q.start();
    const job = q.enqueue('test.wait', { label: 'Wartet auf Abbruch' });
    await tick();
    expect(q.get(job.id).status).toBe('running');
    expect(q.cancel(job.id).cancelRequested).toBe(true);
    await q.whenIdle(1_000);
    // even though the handler threw an ordinary error, the job counts as cancelled (no failure, no retry)
    expect(q.get(job.id)).toMatchObject({ status: 'cancelled', attempts: 1 });
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it('cancelAll cancels queued and running jobs', async () => {
    const q = await makeQueue(0);
    q.register('test.wait', { handler: (job) => new Promise((_r, reject) => job.signal.addEventListener('abort', () => reject(new Error('abgebrochen')))) });
    q.start();
    const a = q.enqueue('test.wait', { label: 'Läuft' });
    const b = q.enqueue('test.wait', { label: 'Wartet' });
    await tick();
    expect(q.cancelAll()).toBe(2);
    await q.whenIdle(1_000);
    expect(q.get(a.id).status).toBe('cancelled');
    expect(q.get(b.id).status).toBe('cancelled');
    expect(q.cancelAll()).toBe(0);
  });

  it('cancels the archive check between its steps', async () => {
    let jobId = '';
    vi.spyOn(app.services.contradictions, 'scanAll').mockImplementation(async () => {
      app.services.jobs.cancel(jobId);
      return [];
    });
    jobId = app.services.enqueueConsistency('manual').id;
    await app.services.jobs.whenIdle();
    expect(app.services.jobs.get(jobId).status).toBe('cancelled');
    expect(app.services.notifications.list().some((n) => n.type === 'consistency_done')).toBe(false);
  });

  it('cancels a running document analysis: job "cancelled", document can be reprocessed, no error message', async () => {
    // the cancel arrives while the text is being extracted
    failExtraction(
      0,
      () => new Error('unused'),
      () => app.services.jobs.cancel(analyzeJob().id),
    );
    const src = app.file('in/abbruch.txt', 'Ein Dokument, dessen Analyse abgebrochen wird.');
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await app.services.jobs.whenIdle();
    const jobId = analyzeJob().id;

    expect(app.services.jobs.get(jobId).status).toBe('cancelled');
    const d = await app.ok('documents:get', { id });
    expect(d.status).toBe('failed');
    expect(d.processingError).toMatch(/abgebrochen/);
    expect(importFailures(id)).toHaveLength(0);

    vi.restoreAllMocks();
    await app.ok('documents:classify', { documentId: id, allowLlm: true });
    await app.services.jobs.whenIdle();
    expect((await app.ok('documents:get', { id })).status).toBe('proposed');
  });
});

describe('Document analysis with retry', () => {
  it('sets neither "failed" nor a notification after a transient error when the next attempt succeeds', async () => {
    // state of the document (and its notifications) at the start of every attempt
    const seen: { status: string; notified: number }[] = [];
    failExtraction(1, transient, () => {
      const docId = analyzedDocId();
      seen.push({ status: app.services.documents.getRow(docId).status, notified: importFailures(docId).length });
    });
    const src = app.file('in/gesperrt.txt', 'Ein Dokument, das kurz gesperrt ist und dann gelesen werden kann.');
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await app.services.jobs.whenIdle();

    expect(analyzeJob()).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(seen).toEqual([
      { status: 'analyzing', notified: 0 },
      { status: 'analyzing', notified: 0 },
    ]);
    expect((await app.ok('documents:get', { id })).status).toBe('proposed');
    expect(importFailures(id)).toHaveLength(0);
  });

  it('sets "failed" and notifies exactly once when the last attempt fails too', async () => {
    failExtraction(99, transient);
    const src = app.file('in/dauerhaft-gesperrt.txt', 'Ein Dokument, das dauerhaft gesperrt bleibt.');
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await app.services.jobs.whenIdle();

    expect(analyzeJob()).toMatchObject({ status: 'failed', attempts: 5 });
    const d = await app.ok('documents:get', { id });
    expect(d.status).toBe('failed');
    expect(d.processingError).toMatch(/gesperrt/);
    expect(importFailures(id)).toHaveLength(1);
  });
});

describe('Listing jobs for the job views', () => {
  it('shows summary and run of a job without loading its payload, and filters by type and activity', async () => {
    const queue = await makeQueue(0);
    queue.register<{ runId: string; blob: string }>('test.big', { handler: async () => ({ summary: 'Fertig.' }) });
    const big = 'x'.repeat(200_000);
    const done = queue.enqueue('test.big', { label: 'Groß', payload: { runId: 'run-1', blob: big } });
    queue.start();
    await queue.whenIdle();
    await queue.stop();
    const waiting = queue.enqueue('test.other', { label: 'Wartet', payload: { blob: big } });

    const all = queue.list();

    expect(all.find((job) => job.id === done.id)).toMatchObject({ status: 'succeeded', summary: 'Fertig.', runId: 'run-1' });
    expect(JSON.stringify(all)).not.toContain('xxxx');
    expect(queue.list(10, { type: 'test.big' }).map((job) => job.id)).toEqual([done.id]);
    expect(queue.list(10, { activeOnly: true }).map((job) => job.id)).toEqual([waiting.id]);
  });
});
