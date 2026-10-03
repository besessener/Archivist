import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRASHED_JOB_ERROR, JOB_RETENTION_DAYS, JobQueueService, type JobContext } from '../../packages/core/src/services/jobs';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

/** Issue #216: crash loops, re-runs that pay the LLM again, duplicate jobs and jobs that are never removed. */

let app: TestApp;
let queues: JobQueueService[] = [];

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto', scanEnabled: true });
  app.llm.on('DocumentClassification', (_s, input) =>
    classification({ title: input.includes('Zweite') ? 'Zweite' : 'Datei', summary: 'Zusammenfassung', categoryPath: 'work/notes', mainTopic: 'Scan' }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const q of queues) await q.stop();
  queues = [];
  await app.cleanup();
});

/** A fresh queue on the test app's database, like the queue of the next app start (the app's own queue is paused). */
async function nextStartQueue(): Promise<JobQueueService> {
  await app.services.jobs.stop();
  const q = new JobQueueService(app.services.ctx, { concurrency: 1, retryBaseDelayMs: 0 });
  queues.push(q);
  return q;
}

const sql = (query: string, ...params: unknown[]) => app.services.database.sqlite.prepare(query).run(...params);

/** Leaves a job behind as `running` with `attempts` used, as a crash of the app would. */
function crashedJob(q: JobQueueService, type: string, attempts: number, maxAttempts: number): string {
  const id = q.enqueue(type, { label: `${type} ${attempts}/${maxAttempts}`, payload: {}, maxAttempts }).id;
  sql("UPDATE jobs SET status = 'running', attempts = ? WHERE id = ?", attempts, id);
  return id;
}

describe('jobs left running by a crash', () => {
  it('continue while they have an attempt left and fail instead of looping when they have none', async () => {
    const q = await nextStartQueue();
    const onFailed = vi.fn();
    const runs: string[] = [];
    q.register('test.crash', { handler: async (job) => void runs.push(job.id), hooks: { onFailed } });
    const resumeOnce = crashedJob(q, 'test.crash', 1, 1); // one resume after a crash, even with maxAttempts 1
    const crashedTwice = crashedJob(q, 'test.crash', 2, 1);
    const withRetries = crashedJob(q, 'test.crash', 2, 3);
    const exhausted = crashedJob(q, 'test.crash', 3, 3);

    expect(q.start()).toBe(2);
    await q.whenIdle(5_000);
    expect(runs.sort()).toEqual([resumeOnce, withRetries].sort());
    for (const id of [crashedTwice, exhausted]) expect(q.get(id)).toMatchObject({ status: 'failed', error: CRASHED_JOB_ERROR });
    expect(onFailed.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual([crashedTwice, exhausted].sort());
  });

  it('marks a document whose analysis crashed the app on every attempt as failed instead of analysing it again', async () => {
    const imp = await app.ok('documents:import', { paths: [app.file('in/a.txt', 'Inhalt der Datei')] });
    await app.services.jobs.whenIdle();
    const id = imp.imported[0]!.id;
    const jobs = app.services.jobs;
    await jobs.stop();
    const job = jobs.list().find((j) => j.type === 'document.analyze')!;
    sql("UPDATE jobs SET status = 'running', attempts = max_attempts WHERE id = ?", job.id);
    sql("UPDATE documents SET status = 'analyzing' WHERE id = ?", id);
    const calls = app.llm.calls.length;
    jobs.start(); // the next start, with the app's own handlers and hooks
    await jobs.whenIdle(5_000);
    expect(jobs.get(job.id)).toMatchObject({ status: 'failed', error: CRASHED_JOB_ERROR });
    expect(app.llm.calls.length).toBe(calls);
    expect(app.services.documents.getRow(id).status).toBe('failed');
  });
});

describe('finished jobs', () => {
  it(`are removed ${JOB_RETENTION_DAYS} days after they ended; running, waiting and recent ones stay`, async () => {
    const q = await nextStartQueue();
    const day = 86_400_000;
    const ids = ['succeeded', 'failed', 'cancelled', 'recent', 'pending'].map((label) => q.enqueue('test.none', { label }).id);
    const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
    sql("UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE id = ?", ago(JOB_RETENTION_DAYS + 1), ids[0]);
    sql("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?", ago(JOB_RETENTION_DAYS + 5), ids[1]);
    sql("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?", ago(JOB_RETENTION_DAYS + 1), ids[2]);
    sql("UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE id = ?", ago(1), ids[3]);
    sql('UPDATE jobs SET created_at = ? WHERE id = ?', ago(JOB_RETENTION_DAYS + 9), ids[4]);
    q.register('test.none', { handler: async () => undefined });
    q.start();
    await q.whenIdle(5_000);
    const left = new Set(q.list(1000).map((j) => j.id));
    expect(ids.map((id) => left.has(id))).toEqual([false, false, false, true, true]);
  });
});

describe('duplicate jobs', () => {
  it('a scan request while a scan of the same folder (or of all folders) is queued returns that scan', async () => {
    await app.services.jobs.stop();
    const dl = path.join(app.home, 'Downloads');
    const docs = path.join(app.home, 'Dokumente');
    app.file('Downloads/a.txt', 'A');
    app.file('Dokumente/b.txt', 'B');
    const rootA = await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    const rootB = await app.ok('scanner:addDirectory', { path: docs, recursive: true });
    const onlyA = app.services.scanner.startScan(rootA.id);
    expect(app.services.scanner.startScan(rootA.id, 'interval').id).toBe(onlyA.id);
    const onlyB = app.services.scanner.startScan(rootB.id);
    expect(onlyB.id).not.toBe(onlyA.id);
    const all = app.services.scanner.startScan(undefined, 'startup');
    expect(app.services.scanner.startScan(undefined).id).toBe(all.id);
    expect(app.services.jobs.activePayloads('scanner.scan')).toHaveLength(3);
    // once the queued scans have ended, a new request queues a new scan
    app.services.jobs.cancelAll();
    expect(app.services.scanner.startScan(rootA.id).id).not.toBe(onlyA.id);
  });

  it('a requested archive check while one is queued returns that check', async () => {
    await app.services.jobs.stop();
    const first = app.services.enqueueConsistency('startup');
    expect(app.services.enqueueConsistency('interval').id).toBe(first.id);
    expect(app.services.jobs.activePayloads('consistency.check')).toHaveLength(1);
  });
});

describe('a batch analysis that runs again', () => {
  async function scannedFiles(): Promise<string[]> {
    const dl = path.join(app.home, 'Downloads');
    app.file('Downloads/eins.txt', 'Erste gescannte Datei mit Inhalt.');
    app.file('Downloads/zwei.txt', 'Zweite gescannte Datei mit Inhalt.');
    app.file('Downloads/drei.txt', 'Dritte gescannte Datei mit Inhalt.');
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const files = (await app.ok('scanner:getResults', {})).files;
    return ['eins.txt', 'zwei.txt', 'drei.txt'].map((n) => files.find((f) => f.name === n)!.id);
  }

  const classifications = () => app.llm.calls.filter((c) => c.schema === 'DocumentClassification').length;

  it('continues after the files it already handled instead of paying the LLM for them again', async () => {
    const ids = await scannedFiles();
    // the first run stops (crash, quit) after the first file
    await app.services.jobs.stop();
    const q = await nextStartQueue();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((r) => (release = r));
    const scanner = app.services.scanner;
    let checkpoints = 0;
    q.register<{ fileIds: string[] }>('scanner.analyze', {
      handler: async (job) => {
        const ctx: JobContext = {
          ...job,
          saveCheckpoint: (data) => {
            job.saveCheckpoint(data);
            checkpoints += 1;
            if (checkpoints === 1) throw Object.assign(new Error('Absturz'), { simulatedCrash: true });
          },
        };
        if (job.attempts === 1)
          return scanner.analyzeFiles(job.payload.fileIds, { confirmLlm: true, job: ctx }).catch(async (err: { simulatedCrash?: boolean }) => {
            if (err.simulatedCrash) await blocked; // the process "dies" here: the job stays running
            throw err;
          });
        return scanner.analyzeFiles(job.payload.fileIds, { confirmLlm: true, job });
      },
    });
    q.start();
    const job = q.enqueue('scanner.analyze', { label: 'Analysiere 3 Datei(en)', payload: { fileIds: ids, confirmLlm: true }, maxAttempts: 1 });
    await vi.waitFor(() => expect(checkpoints).toBe(1));
    expect(classifications()).toBe(1);
    expect(q.get(job.id).status).toBe('running');

    // next start: the job continues with the remaining two files only
    const next = new JobQueueService(app.services.ctx, { concurrency: 1, retryBaseDelayMs: 0 });
    queues.push(next);
    next.register<{ fileIds: string[] }>('scanner.analyze', { handler: (j) => scanner.analyzeFiles(j.payload.fileIds, { confirmLlm: true, job: j }) });
    expect(next.start()).toBe(1);
    await next.whenIdle(5_000);
    expect(next.get(job.id).status).toBe('succeeded');
    expect(classifications()).toBe(3);
    const result = next.getResult(job.id) as { analyzed: string[]; skipped: string[] };
    expect(result.analyzed).toHaveLength(3);
    const files = (await app.ok('scanner:getResults', {})).files.filter((f) => ids.includes(f.id));
    expect(files.every((f) => f.status === 'analyzed')).toBe(true);
    release();
  });
});
