import type { Job } from '@archivist/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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

/**
 * The job was interrupted because the app quits. Unlike a cancellation the job is not over: it stays `pending`
 * and runs again after the next start. Handlers treat it like a cancellation (stop the work, keep no partial state
 * that would block a later run) – `isJobCancelled` is true for it as well.
 */
export class JobInterruptedError extends JobCancelledError {
  constructor() {
    super();
    this.message = 'Job beim Beenden unterbrochen';
    this.name = 'JobInterruptedError';
  }
}

/**
 * True if `err` means "stop the job's work now" (thrown by `throwIfCancelled` or `signal.throwIfAborted()`):
 * a cancellation or an interruption on quit.
 */
export const isJobCancelled = (err: unknown): boolean => err instanceof JobCancelledError;

/** True if `err` is an interruption on quit: the job resumes after the next start, so it is no final cancellation. */
export const isJobInterrupted = (err: unknown): boolean => err instanceof JobInterruptedError;

/** Message of a job that was interrupted on quit and waits for the next start. */
export const INTERRUPTED_JOB_MESSAGE = 'Beim Beenden unterbrochen – wird beim nächsten Start fortgesetzt';

export interface JobContext<P = unknown> {
  id: string;
  type: string;
  payload: P;
  attempts: number;
  report(progress: number | null, message?: string): void;
  isCancelled(): boolean;
  throwIfCancelled(): void;
  /**
   * Aborted as soon as the job is cancelled or interrupted on quit. Its `reason` is a `JobCancelledError` (or a
   * `JobInterruptedError`), so `signal.throwIfAborted()` behaves like `throwIfCancelled()`. Pass it on to
   * cancellable work (e.g. LLM requests).
   */
  signal: AbortSignal;
}

export type JobHandler<P = never> = (job: JobContext<P>) => Promise<unknown>;

/** Optional lifecycle hooks of a job type. They run after the job's final status has been stored. */
export interface JobHooks<P = unknown> {
  /** The last attempt failed and no retry follows. Not called for failures that are retried. */
  onFailed?(job: { id: string; payload: P; attempts: number }, error: unknown): void;
  /** The job ended as `cancelled`, whether it was still waiting (e.g. for a retry) or already running. */
  onCancelled?(job: { id: string; payload: P }): void;
}

export interface JobQueueOptions {
  /** Number of jobs running in parallel (default 2). */
  concurrency?: number;
  /** Wait before the first retry; every further retry waits twice as long (default 5 s). */
  retryBaseDelayMs?: number;
  /** Upper bound for the wait between two attempts (default 5 min). */
  retryMaxDelayMs?: number;
}

/** Exponential backoff: the wait after `failedAttempts` failed attempts (1 → base, 2 → 2 × base, …), capped at `maxMs`. */
export function retryDelayMs(failedAttempts: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failedAttempts - 1));
}

type Row = typeof jobs.$inferSelect;
type Registration = { handler: JobHandler<never>; hooks: JobHooks<never> };

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
 *
 * Retryable failures are queued again with exponential backoff. The wait is kept in memory only: after a
 * restart a waiting job runs right away. Cancelling aborts the running job's `signal`; handlers check it at
 * sensible points, and the job then ends as `cancelled`.
 */
export class JobQueueService {
  private handlers = new Map<string, Registration>();
  private running = new Set<string>();
  private active = new Map<string, Promise<void>>();
  /** Abort controllers of the running jobs (aborted by `cancel` and `interrupt`). */
  private controllers = new Map<string, AbortController>();
  /**
   * Running jobs given up by `interrupt` after its timeout: their rows are already back to `pending`, so whatever
   * the still running handler does afterwards is no longer recorded (the database may be closed by then).
   */
  private abandoned = new Set<string>();
  /** Pending jobs waiting for their next attempt: job id → earliest start (epoch ms). */
  private retryAt = new Map<string, number>();
  private retryTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    private readonly ctx: AppContext,
    opts: JobQueueOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 5_000;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? 300_000;
  }

  private get db() {
    return this.ctx.database.db;
  }

  register<P>(type: string, handler: JobHandler<P>, hooks: JobHooks<P> = {}): void {
    this.handlers.set(type, { handler, hooks });
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
    const rows = this.db
      .select({ status: jobs.status, c: sql<number>`count(*)` })
      .from(jobs)
      .where(inArray(jobs.status, ['pending', 'running', 'failed']))
      .groupBy(jobs.status)
      .all();
    const get = (s: string) => rows.find((r) => r.status === s)?.c ?? 0;
    return { pending: get('pending'), running: get('running'), failed: get('failed') };
  }

  /** Payloads of all pending or running jobs of the given type (e.g. to find work that is still queued). */
  activePayloads<P>(type: string): P[] {
    return this.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.type, type), inArray(jobs.status, ['pending', 'running'])))
      .all()
      .map((r) => r.payload as P);
  }

  retry(id: string): Job {
    const r = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Job nicht gefunden.');
    if (r.status !== 'failed' && r.status !== 'cancelled')
      throw new AppError('validation_error', 'Nur fehlgeschlagene oder abgebrochene Jobs können wiederholt werden.');
    this.db
      .update(jobs)
      .set({ status: 'pending', error: null, attempts: 0, cancelRequested: false, finishedAt: null, progress: null, progressMessage: null })
      .where(eq(jobs.id, id))
      .run();
    this.retryAt.delete(id);
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    this.notify(row);
    this.kick();
    return mapJob(row);
  }

  /**
   * Sicherer Abbruch: wartende Jobs (auch solche, die auf eine Wiederholung warten) sofort, laufende
   * kooperativ – ihr `signal` wird abgebrochen, und der Handler endet an der nächsten Prüfstelle.
   */
  cancel(id: string): Job {
    const r = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Job nicht gefunden.');
    if (r.status === 'pending' && !this.running.has(id)) {
      this.db.update(jobs).set({ status: 'cancelled', finishedAt: nowIso(), cancelRequested: true, progressMessage: null }).where(eq(jobs.id, id)).run();
      this.retryAt.delete(id);
      const hooks = this.handlers.get(r.type)?.hooks;
      this.runHook(r.type, 'onCancelled', () => hooks?.onCancelled?.({ id, payload: r.payload as never }));
    } else if (r.status === 'pending' || r.status === 'running') {
      this.db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, id)).run();
      this.controllers.get(id)?.abort(new JobCancelledError());
    }
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    this.notify(row);
    return mapJob(row);
  }

  /** Cancels every pending and running job (see `cancel`). Returns the number of jobs affected. */
  cancelAll(): number {
    const ids = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.status, ['pending', 'running']), eq(jobs.cancelRequested, false)))
      .all()
      .map((r) => r.id);
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  /** Startet die Verarbeitung; unterbrochene Jobs aus einer früheren Sitzung werden wieder eingereiht. */
  start(): number {
    const res = this.db.update(jobs).set({ status: 'pending', progressMessage: 'Nach Neustart fortgesetzt' }).where(eq(jobs.status, 'running')).run();
    this.started = true;
    this.stopping = false;
    this.kick();
    return res.changes;
  }

  /** Pauses the queue: no further job starts, and running jobs are awaited until they end on their own. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.clearRetryTimer();
    await Promise.allSettled([...this.active.values()]);
  }

  /**
   * Stops the queue for quitting the app without hanging on running jobs. No further job starts; running jobs are
   * interrupted (their `signal` aborts with a `JobInterruptedError`) and go back to `pending` without using up an
   * attempt, so they run again after the next `start()`. Waits at most `timeoutMs` for them to end; jobs still
   * running then are put back to `pending` right away and whatever they do afterwards is ignored. Waiting jobs
   * (including those waiting for a retry) simply stay `pending`.
   *
   * Returns how many jobs were interrupted and how many of them did not end within the timeout.
   */
  async interrupt(timeoutMs = 5_000): Promise<{ interrupted: number; unfinished: number }> {
    this.stopping = true;
    this.started = false;
    this.clearRetryTimer();
    const running = [...this.active.keys()].filter((id) => !this.abandoned.has(id));
    for (const id of running) this.controllers.get(id)?.abort(new JobInterruptedError());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(running.flatMap((id) => this.active.get(id) ?? [])), timeout]);
    clearTimeout(timer);
    const unfinished = running.filter((id) => this.active.has(id));
    for (const id of unfinished) {
      this.abandoned.add(id);
      const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
      if (row?.status === 'running') this.requeueInterrupted(row, row.attempts - 1);
    }
    if (running.length) this.ctx.logger.info('jobs', 'Jobs beim Beenden unterbrochen', { interrupted: running.length, unfinished: unfinished.length });
    return { interrupted: running.length, unfinished: unfinished.length };
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
    // One instant for picking due work and for planning the retry timer: if the timer decision read the clock
    // again, a retry that became due in between would count as "already due" without having been picked, and
    // with no job running nothing would ever start it.
    let now = Date.now();
    while (this.running.size < this.concurrency) {
      now = Date.now();
      const next = this.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, 'pending'))
        .orderBy(jobs.createdAt)
        .limit(this.running.size + this.retryAt.size + 1)
        .all()
        .find((j) => !this.running.has(j.id) && (this.retryAt.get(j.id) ?? 0) <= now);
      if (!next) break;
      this.retryAt.delete(next.id);
      this.running.add(next.id);
      const p = this.execute(next).finally(() => {
        this.running.delete(next.id);
        this.active.delete(next.id);
        this.kick();
      });
      this.active.set(next.id, p);
    }
    this.scheduleRetryTimer(now);
  }

  /**
   * Wakes the queue when the earliest waiting retry is due. `now` must be the instant `kick` last looked for
   * due work: retries due at that instant need no timer, because `kick` either started them or stopped with
   * every slot busy, and each finished job kicks the queue again.
   */
  private scheduleRetryTimer(now: number): void {
    this.clearRetryTimer();
    if (!this.started || this.stopping) return;
    const upcoming = [...this.retryAt.values()].filter((t) => t > now);
    if (!upcoming.length) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.kick();
      },
      Math.min(...upcoming) - now,
    );
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private runHook(type: string, hook: keyof JobHooks, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.ctx.logger.error('jobs', `Job-Hook ${hook} fehlgeschlagen: ${type}`, { error: err });
    }
  }

  private async execute(job: Row): Promise<void> {
    const registered = this.handlers.get(job.type);
    const attempts = job.attempts + 1;
    this.db.update(jobs).set({ status: 'running', attempts, startedAt: nowIso(), error: null }).where(eq(jobs.id, job.id)).run();
    this.notify({ ...job, status: 'running', attempts });
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const isCancelled = () => controller.signal.aborted || Boolean(this.db.select({ c: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, job.id)).get()?.c);
    // a cancel requested before this attempt started (e.g. in an earlier session) applies right away
    if (isCancelled()) controller.abort(new JobCancelledError());
    const ctx: JobContext<unknown> = {
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempts,
      report: (progress: number | null, message?: string) => {
        if (this.abandoned.has(job.id)) return;
        this.db
          .update(jobs)
          .set({ progress, progressMessage: message ?? null })
          .where(eq(jobs.id, job.id))
          .run();
        this.notify({ ...job, status: 'running', progress, progressMessage: message ?? null });
      },
      isCancelled,
      throwIfCancelled: () => {
        if (!isCancelled()) return;
        // the signal's reason tells a cancellation from an interruption on quit
        throw controller.signal.reason instanceof JobCancelledError ? controller.signal.reason : new JobCancelledError();
      },
      signal: controller.signal,
    };
    let outcome: { ok: true; result: unknown } | { ok: false; error: unknown };
    try {
      if (!registered) throw new AppError('validation_error', `Kein Handler für Jobtyp „${job.type}“ registriert.`);
      ctx.throwIfCancelled();
      outcome = { ok: true, result: await registered.handler(ctx as never) };
    } catch (err) {
      outcome = { ok: false, error: err };
    } finally {
      this.controllers.delete(job.id);
    }
    if (this.abandoned.delete(job.id)) return; // given up by `interrupt`: the row is already back to `pending`
    if (!outcome.ok && controller.signal.reason instanceof JobInterruptedError) {
      // interrupted on quit: whatever the handler threw then (an aborted request, a closed worker pool …) is no failure
      this.requeueInterrupted(job, job.attempts);
      return;
    }
    this.settle(job, attempts, outcome, registered, isCancelled);
  }

  /** Puts a job interrupted on quit back to `pending`; `attempts` is the count before the interrupted attempt. */
  private requeueInterrupted(job: Row, attempts: number): void {
    this.db
      .update(jobs)
      .set({ status: 'pending', attempts: Math.max(0, attempts), progressMessage: INTERRUPTED_JOB_MESSAGE, startedAt: null })
      .where(eq(jobs.id, job.id))
      .run();
    this.ctx.logger.info('jobs', `Job beim Beenden unterbrochen: ${job.type}`, { jobId: job.id });
    const row = this.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    if (row) this.notify(row);
  }

  /** Stores the final status of an attempt (succeeded, cancelled, waiting for a retry or failed). */
  private settle(
    job: Row,
    attempts: number,
    outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
    registered: Registration | undefined,
    isCancelled: () => boolean,
  ): void {
    if (outcome.ok) {
      const result = outcome.result;
      this.db
        .update(jobs)
        .set({ status: 'succeeded', progress: 1, progressMessage: null, result: (result ?? null) as ArchivistJson | null, finishedAt: nowIso() })
        .where(eq(jobs.id, job.id))
        .run();
    } else {
      const err = outcome.error;
      if (isJobCancelled(err) || isCancelled()) {
        // whatever the handler threw after a cancel request (e.g. an aborted LLM request): the job was cancelled
        this.db.update(jobs).set({ status: 'cancelled', progressMessage: null, finishedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
        this.ctx.logger.info('jobs', `Job abgebrochen: ${job.type}`, { jobId: job.id, attempts });
        this.runHook(job.type, 'onCancelled', () => registered?.hooks.onCancelled?.({ id: job.id, payload: job.payload as never }));
      } else this.recordFailure(job, attempts, err, registered);
    }
    const row = this.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    if (row) this.notify(row);
  }

  /** A failed attempt: retryable errors wait (exponential backoff) for the next attempt, otherwise the job fails. */
  private recordFailure(job: Row, attempts: number, err: unknown, registered: Registration | undefined): void {
    const info = toErrorInfo(err);
    const error = `${info.message}${info.details ? ` – ${info.details}` : ''}`;
    if (info.retryable && attempts < job.maxAttempts) {
      const delay = retryDelayMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs);
      this.retryAt.set(job.id, Date.now() + delay);
      this.ctx.logger.warn('jobs', `Job fehlgeschlagen, neuer Versuch folgt: ${job.type}`, { jobId: job.id, error: err, attempts, delayMs: delay });
      this.db
        .update(jobs)
        .set({
          status: 'pending',
          error,
          progress: null,
          progressMessage: `Neuer Versuch in ${Math.max(1, Math.round(delay / 1000))} s (Versuch ${attempts + 1} von ${job.maxAttempts})`,
          finishedAt: null,
        })
        .where(eq(jobs.id, job.id))
        .run();
      return;
    }
    this.ctx.logger.error('jobs', `Job fehlgeschlagen: ${job.type}`, { jobId: job.id, error: err, attempts });
    this.db.update(jobs).set({ status: 'failed', error, progressMessage: null, finishedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
    this.runHook(job.type, 'onFailed', () => registered?.hooks.onFailed?.({ id: job.id, payload: job.payload as never, attempts }, err));
  }
}
