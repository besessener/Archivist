import { AsyncLocalStorage } from 'node:async_hooks';
import type { Job } from '@archivist/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { jobs } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { ArchivistJson } from '../util/json';
import { AttemptOutcomes, type Outcome } from './jobs/attempt-outcome';
import { pruneFinishedJobs, recoverCrashedJobs } from './jobs/job-maintenance';
import { createJobContext } from './jobs/job-context';
import { JobCancelledError, JobInterruptedError } from './jobs/job-errors';
import { listJobs, type JobListFilter } from './jobs/job-list';
import { mapJob, newJobRow, type JobRow } from './jobs/job-rows';
import { pollUntil } from './jobs/polling';
import type { JobHandler, JobHooks, JobQueueOptions, Registration } from './jobs/job-types';
import { RetryWaits } from './jobs/retry-waits';

export { INTERRUPTED_JOB_MESSAGE } from './jobs/attempt-outcome';
export { isJobCancelled, isJobInterrupted, JobCancelledError } from './jobs/job-errors';
export type { JobContext } from './jobs/job-types';

export { CRASHED_JOB_ERROR, JOB_RETENTION_DAYS } from './jobs/job-maintenance';

/** Exponential backoff: the wait after `failedAttempts` failed attempts (1 → base, 2 → 2 × base, …), capped at `maxMs`. */
export function retryDelayMs(failedAttempts: number, { baseMs, maxMs }: { baseMs: number; maxMs: number }): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failedAttempts - 1));
}

/** Persistent SQLite job queue: survives restarts, retries with backoff (waits kept in memory only), cancels cooperatively. */
export class JobQueueService {
  private handlers = new Map<string, Registration>();
  private running = new Set<string>();
  private active = new Map<string, Promise<void>>();
  /** Abort controllers of the running jobs (aborted by `cancel` and `interrupt`). */
  private controllers = new Map<string, AbortController>();
  /** Running jobs `interrupt` gave up after its timeout: their rows are `pending` again, later handler activity is ignored. */
  private abandoned = new Set<string>();
  private readonly retryWaits = new RetryWaits();
  private started = false;
  private stopping = false;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly outcomes: AttemptOutcomes;
  /** Runs a job in the queue's own async context: the scope of whoever queued it (agent run, chat cancel) must not leak in. */
  private readonly inQueueContext = AsyncLocalStorage.snapshot();

  constructor(
    private readonly ctx: AppContext,
    options: JobQueueOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 5_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 300_000;
    this.outcomes = new AttemptOutcomes({
      ctx,
      retryWaits: this.retryWaits,
      retryDelay: (failedAttempts, err) => (err instanceof AppError ? err.retryAfterMs : undefined) ?? this.backoffMs(failedAttempts),
      runHook: (target, run) => this.runHook(target, run),
      notify: (row) => this.notify(row),
    });
  }

  /** The wait before the next attempt after `failedAttempts` failed ones – also for work a job retries inside itself. */
  backoffMs(failedAttempts: number): number {
    return retryDelayMs(failedAttempts, { baseMs: this.retryBaseDelayMs, maxMs: this.retryMaxDelayMs });
  }

  private get db() {
    return this.ctx.database.db;
  }

  register<P>(type: string, { handler, hooks = {} }: { handler: JobHandler<P>; hooks?: JobHooks<P> }): void {
    this.handlers.set(type, { handler, hooks });
  }

  /** Queues a job; with `sameAs`, a matching pending or running job of the type (payload, status) is returned instead. */
  enqueue<P = unknown>(
    type: string,
    {
      label,
      payload = {} as P,
      ...options
    }: { label: string; payload?: P; maxAttempts?: number; sameAs?: (active: P, status: 'pending' | 'running') => boolean },
  ): Job {
    const { sameAs } = options;
    if (sameAs) {
      const existing = this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, type), inArray(jobs.status, ['pending', 'running']), eq(jobs.cancelRequested, false)))
        .orderBy(jobs.createdAt)
        .all()
        .find((row) => sameAs(row.payload as P, row.status as 'pending' | 'running'));
      if (existing) return mapJob(existing);
    }
    const row = newJobRow({ type, label, payload, maxAttempts: options.maxAttempts ?? 3 });
    this.db.insert(jobs).values(row).run();
    this.notify(row);
    this.kick();
    return mapJob(row);
  }

  private row(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  private existingRow(id: string): JobRow {
    const row = this.row(id);
    if (!row) throw new AppError('validation_error', 'Job nicht gefunden.');
    return row;
  }

  get(id: string): Job {
    return mapJob(this.existingRow(id));
  }

  /** The payload a job was queued with. */
  payloadOf<P>(id: string): P | undefined {
    return this.row(id)?.payload as P | undefined;
  }

  /** Replaces the payload of a job, e.g. a consent given while it waits or runs; the handler reads it again where it needs it. */
  updatePayload<P>(id: string, payload: P): void {
    this.db
      .update(jobs)
      .set({ payload: payload as ArchivistJson })
      .where(eq(jobs.id, id))
      .run();
  }

  getResult(id: string): unknown {
    return this.row(id)?.result ?? null;
  }

  /** Newest first; reads only the columns a list shows, optionally just the pending or running jobs of one type. */
  list(limit = 100, filter: JobListFilter = {}): Job[] {
    return listJobs(this.db, { limit, ...filter });
  }

  counts(): { pending: number; running: number; failed: number } {
    const rows = this.db
      .select({ status: jobs.status, count: sql<number>`count(*)` })
      .from(jobs)
      .where(inArray(jobs.status, ['pending', 'running', 'failed']))
      .groupBy(jobs.status)
      .all();
    const countOf = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
    return { pending: countOf('pending'), running: countOf('running'), failed: countOf('failed') };
  }

  /** Payloads of all pending or running jobs of the given type (e.g. to find work that is still queued). */
  activePayloads<P>(type: string): P[] {
    return this.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.type, type), inArray(jobs.status, ['pending', 'running'])))
      .all()
      .map((row) => row.payload as P);
  }

  retry(id: string): Job {
    const current = this.existingRow(id);
    if (current.status !== 'failed' && current.status !== 'cancelled')
      throw new AppError('validation_error', 'Nur fehlgeschlagene oder abgebrochene Jobs können wiederholt werden.');
    this.db
      .update(jobs)
      .set({ status: 'pending', error: null, attempts: 0, cancelRequested: false, finishedAt: null, progress: null, progressMessage: null })
      .where(eq(jobs.id, id))
      .run();
    this.retryWaits.delete(id);
    const row = this.row(id)!;
    this.notify(row);
    this.kick();
    return mapJob(row);
  }

  /** Lets the jobs paused by the daily token limit run again (the limit was raised or switched off). */
  resumeTokenCapPaused(): void {
    this.outcomes.pausedForTokenCap.forEach((id) => this.retryWaits.delete(id));
    this.outcomes.pausedForTokenCap.clear();
    this.kick();
  }

  /** Cancels waiting jobs (also those waiting for a retry) at once, running ones cooperatively via their `signal`. */
  cancel(id: string): Job {
    const current = this.existingRow(id);
    if (current.status === 'pending' && !this.running.has(id)) {
      this.db.update(jobs).set({ status: 'cancelled', finishedAt: nowIso(), cancelRequested: true, progressMessage: null }).where(eq(jobs.id, id)).run();
      this.retryWaits.delete(id);
      const hooks = this.handlers.get(current.type)?.hooks;
      this.runHook({ type: current.type, hook: 'onCancelled' }, () => hooks?.onCancelled?.({ id, payload: current.payload as never }));
    } else if (current.status === 'pending' || current.status === 'running') {
      this.db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, id)).run();
      this.controllers.get(id)?.abort(new JobCancelledError());
    }
    const row = this.row(id)!;
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
      .map((row) => row.id);
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  /** Starts processing: jobs a crash left `running` are requeued or fail; prunes old jobs. */
  start(): number {
    const requeued = recoverCrashedJobs(this.ctx, { handlers: this.handlers, runHook: (target, run) => this.runHook(target, run) });
    this.prune();
    this.started = true;
    this.stopping = false;
    this.kick();
    return requeued;
  }

  /** Removes finished jobs older than `JOB_RETENTION_DAYS`. Returns the number of removed jobs. */
  prune(now = Date.now()): number {
    return pruneFinishedJobs(this.ctx, now);
  }

  /** Pauses the queue: no further job starts, and running jobs are awaited until they end on their own. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.retryWaits.clearTimer();
    await Promise.allSettled([...this.active.values()]);
  }

  /** Stops for quitting: running jobs are interrupted back to `pending` without using an attempt, awaited at most `timeoutMs`. */
  async interrupt(timeoutMs = 5_000): Promise<{ interrupted: number; unfinished: number }> {
    this.stopping = true;
    this.started = false;
    this.retryWaits.clearTimer();
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
      const row = this.row(id);
      if (row?.status === 'running') this.outcomes.requeueInterrupted(row, row.attempts - 1);
    }
    if (running.length) this.ctx.logger.info('jobs', 'Jobs interrupted on quit', { interrupted: running.length, unfinished: unfinished.length });
    return { interrupted: running.length, unfinished: unfinished.length };
  }

  /** Waits for one job to end, at most `timeoutMs`; returns its latest state, which is still pending or running after a timeout. */
  async waitFor(id: string, timeoutMs: number): Promise<Job> {
    const ended = (job: Job) => job.status !== 'pending' && job.status !== 'running';
    return (await pollUntil(() => this.get(id), { done: ended, timeoutMs })).value;
  }

  /** Waits until no pending/running jobs exist any more (mainly for tests and shutdown). */
  async whenIdle(timeoutMs = 30_000): Promise<void> {
    const idle = () => {
      const counts = this.counts();
      return counts.pending === 0 && counts.running === 0 && this.active.size === 0;
    };
    if (!(await pollUntil(idle, { done: (isIdle) => isIdle, timeoutMs })).done) throw new Error('Job-Queue wurde nicht rechtzeitig leer');
  }

  private notify(row: JobRow): void {
    this.ctx.events.emit('job:updated', mapJob(row));
    this.ctx.events.changed('jobs');
  }

  private kick(): void {
    if (!this.started || this.stopping) return;
    // one instant for picking due work and planning the retry timer, else a retry due in between would never start
    let now = Date.now();
    while (this.running.size < this.concurrency) {
      now = Date.now();
      const next = this.nextDue(now);
      if (!next) break;
      this.retryWaits.delete(next.id);
      this.running.add(next.id);
      const execution = this.inQueueContext(() => this.execute(next)).finally(() => {
        this.running.delete(next.id);
        this.active.delete(next.id);
        this.kick();
      });
      this.active.set(next.id, execution);
    }
    this.scheduleRetryTimer(now);
  }

  private nextDue(now: number): JobRow | undefined {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'pending'))
      .orderBy(jobs.createdAt)
      .limit(this.running.size + this.retryWaits.size + 1)
      .all()
      .find((row) => !this.running.has(row.id) && this.retryWaits.isDue(row.id, now));
  }

  private scheduleRetryTimer(now: number): void {
    this.retryWaits.clearTimer();
    if (!this.started || this.stopping) return;
    this.retryWaits.schedule(now, () => this.kick());
  }

  private runHook({ type, hook }: { type: string; hook: keyof JobHooks }, run: () => void): void {
    try {
      run();
    } catch (err) {
      this.ctx.logger.error('jobs', `Job hook ${hook} failed: ${type}`, { error: err });
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const registered = this.handlers.get(job.type);
    const attempts = job.attempts + 1;
    this.db.update(jobs).set({ status: 'running', attempts, startedAt: nowIso(), error: null }).where(eq(jobs.id, job.id)).run();
    this.notify({ ...job, status: 'running', attempts });
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const isAbandoned = () => this.abandoned.has(job.id);
    const context = createJobContext({ job, attempts, controller, ctx: this.ctx, isAbandoned, notify: (row) => this.notify(row) });
    // a cancel requested before this attempt started (e.g. in an earlier session) applies right away
    if (context.isCancelled()) controller.abort(new JobCancelledError());
    let outcome: Outcome;
    try {
      if (!registered) throw new AppError('validation_error', `Kein Handler für Jobtyp „${job.type}“ registriert.`);
      context.throwIfCancelled();
      outcome = { ok: true, result: await registered.handler(context as never) };
    } catch (err) {
      outcome = { ok: false, error: err };
    } finally {
      this.controllers.delete(job.id);
    }
    if (this.abandoned.delete(job.id)) return; // given up by `interrupt`: the row is already back to `pending`
    if (!outcome.ok && controller.signal.reason instanceof JobInterruptedError) {
      // interrupted on quit: whatever the handler threw then (an aborted request, a closed worker pool …) is no failure
      this.outcomes.requeueInterrupted(job, job.attempts);
      return;
    }
    this.outcomes.settle({ job, attempts, registered, isCancelled: () => context.isCancelled() }, outcome);
    const row = this.row(job.id);
    if (row) this.notify(row);
  }
}
