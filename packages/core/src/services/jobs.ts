import type { Job } from '@archivist/shared';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { jobs } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { AppError, toErrorInfo } from '../util/errors';
import { newId, nowIso } from '../util/ids';

export class JobCancelledError extends Error {
  constructor() {
    super('Job abgebrochen');
    this.name = 'JobCancelledError';
  }
}

export interface JobContext<P = unknown> {
  id: string;
  type: string;
  payload: P;
  attempts: number;
  report(progress: number | null, message?: string): void;
  isCancelled(): boolean;
  throwIfCancelled(): void;
}

export type JobHandler<P = never> = (job: JobContext<P>) => Promise<unknown>;
type Row = typeof jobs.$inferSelect;

const mapJob = (r: Row): Job => ({
  id: r.id,
  type: r.type,
  label: r.label,
  status: r.status as Job['status'],
  progress: r.progress,
  progressMessage: r.progressMessage,
  attempts: r.attempts,
  error: r.error,
  cancelRequested: r.cancelRequested,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});

/**
 * Persistente Job-Queue in SQLite. Jobs überleben Neustarts: beim Start werden unterbrochene Jobs
 * (Status „running“) wieder auf „pending“ gesetzt. Rechenintensive Teile laufen im WorkerPool.
 */
export class JobQueueService {
  private handlers = new Map<string, JobHandler<never>>();
  private running = new Set<string>();
  private active = new Map<string, Promise<void>>();
  private started = false;
  private stopping = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly concurrency = 2,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  register<P>(type: string, handler: JobHandler<P>): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, label: string, payload: unknown = {}, opts: { maxAttempts?: number } = {}): Job {
    const row: Row = {
      id: newId(),
      type,
      label,
      payload: payload as ArchivistJson,
      status: 'pending',
      progress: null,
      progressMessage: null,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3,
      error: null,
      result: null,
      cancelRequested: false,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    this.db.insert(jobs).values(row).run();
    this.notify(row);
    this.kick();
    return mapJob(row);
  }

  get(id: string): Job {
    const r = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Job nicht gefunden.');
    return mapJob(r);
  }

  getResult(id: string): unknown {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get()?.result ?? null;
  }

  list(limit = 100): Job[] {
    return this.db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit).all().map(mapJob);
  }

  counts(): { pending: number; running: number; failed: number } {
    const rows = this.db.select({ status: jobs.status, c: sql<number>`count(*)` }).from(jobs).where(inArray(jobs.status, ['pending', 'running', 'failed'])).groupBy(jobs.status).all();
    const get = (s: string) => rows.find((r) => r.status === s)?.c ?? 0;
    return { pending: get('pending'), running: get('running'), failed: get('failed') };
  }

  retry(id: string): Job {
    const r = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Job nicht gefunden.');
    if (r.status !== 'failed' && r.status !== 'cancelled') throw new AppError('validation_error', 'Nur fehlgeschlagene oder abgebrochene Jobs können wiederholt werden.');
    this.db.update(jobs).set({ status: 'pending', error: null, attempts: 0, cancelRequested: false, finishedAt: null, progress: null, progressMessage: null }).where(eq(jobs.id, id)).run();
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    this.notify(row);
    this.kick();
    return mapJob(row);
  }

  /** Sicherer Abbruch: wartende Jobs sofort, laufende kooperativ (Handler prüft `isCancelled`). */
  cancel(id: string): Job {
    const r = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Job nicht gefunden.');
    if (r.status === 'pending') {
      this.db.update(jobs).set({ status: 'cancelled', finishedAt: nowIso(), cancelRequested: true }).where(eq(jobs.id, id)).run();
    } else if (r.status === 'running') {
      this.db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, id)).run();
    }
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    this.notify(row);
    return mapJob(row);
  }

  /** Startet die Verarbeitung; unterbrochene Jobs aus einer früheren Sitzung werden wieder eingereiht. */
  start(): number {
    const res = this.db.update(jobs).set({ status: 'pending', progressMessage: 'Nach Neustart fortgesetzt' }).where(eq(jobs.status, 'running')).run();
    this.started = true;
    this.stopping = false;
    this.kick();
    return res.changes;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    await Promise.allSettled([...this.active.values()]);
  }

  /** Wartet, bis keine pending/running Jobs mehr existieren (v. a. für Tests und Shutdown). */
  async whenIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = this.counts();
      if (c.pending === 0 && c.running === 0 && this.active.size === 0) return;
      if (Date.now() > deadline) throw new Error('Job-Queue wurde nicht rechtzeitig leer');
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  private notify(row: Row): void {
    this.ctx.events.emit('job:updated', mapJob(row));
    this.ctx.events.changed('jobs');
  }

  private kick(): void {
    if (!this.started || this.stopping) return;
    while (this.running.size < this.concurrency) {
      const next = this.db.select().from(jobs).where(eq(jobs.status, 'pending')).orderBy(jobs.createdAt).limit(this.running.size + 1).all().find((j) => !this.running.has(j.id));
      if (!next) return;
      this.running.add(next.id);
      const p = this.execute(next).finally(() => {
        this.running.delete(next.id);
        this.active.delete(next.id);
        this.kick();
      });
      this.active.set(next.id, p);
    }
  }

  private async execute(job: Row): Promise<void> {
    const handler = this.handlers.get(job.type);
    const attempts = job.attempts + 1;
    this.db.update(jobs).set({ status: 'running', attempts, startedAt: nowIso(), error: null }).where(eq(jobs.id, job.id)).run();
    this.notify({ ...job, status: 'running', attempts });
    const isCancelled = () => Boolean(this.db.select({ c: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, job.id)).get()?.c);
    const ctx = {
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempts,
      report: (progress: number | null, message?: string) => {
        this.db.update(jobs).set({ progress, progressMessage: message ?? null }).where(eq(jobs.id, job.id)).run();
        this.notify({ ...job, status: 'running', progress, progressMessage: message ?? null });
      },
      isCancelled,
      throwIfCancelled: () => {
        if (isCancelled()) throw new JobCancelledError();
      },
    };
    try {
      if (!handler) throw new AppError('validation_error', `Kein Handler für Jobtyp „${job.type}“ registriert.`);
      const result = await handler(ctx as never);
      this.db.update(jobs).set({ status: 'succeeded', progress: 1, result: (result ?? null) as ArchivistJson | null, finishedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
    } catch (err) {
      if (err instanceof JobCancelledError) {
        this.db.update(jobs).set({ status: 'cancelled', finishedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
      } else {
        const info = toErrorInfo(err);
        const retry = info.retryable && attempts < job.maxAttempts;
        this.ctx.logger.error('jobs', `Job fehlgeschlagen: ${job.type}`, { jobId: job.id, error: err, attempts });
        this.db
          .update(jobs)
          .set({ status: retry ? 'pending' : 'failed', error: `${info.message}${info.details ? ` – ${info.details}` : ''}`, finishedAt: retry ? null : nowIso() })
          .where(eq(jobs.id, job.id))
          .run();
      }
    }
    const row = this.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    if (row) this.notify(row);
  }
}
