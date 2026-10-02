import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { jobs } from '../../db/schema';
import { toErrorInfo } from '../../util/errors';
import { nowIso } from '../../util/ids';
import type { ArchivistJson } from '../../util/json';
import { isJobCancelled } from './job-errors';
import type { JobRow } from './job-rows';
import type { JobHooks, Registration } from './job-types';
import type { RetryWaits } from './retry-waits';

/** Message of a job that was interrupted on quit and waits for the next start. */
export const INTERRUPTED_JOB_MESSAGE = 'Beim Beenden unterbrochen – wird beim nächsten Start fortgesetzt';

export type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };

/** One finished attempt of a job, ready to be recorded. */
export interface FinishedAttempt {
  job: JobRow;
  attempts: number;
  registered: Registration | undefined;
  isCancelled: () => boolean;
}

export interface AttemptOutcomeDeps {
  ctx: AppContext;
  retryWaits: RetryWaits;
  /** Wait before the next attempt after `failedAttempts` failed ones. */
  retryDelay: (failedAttempts: number) => number;
  runHook: (type: string, hook: keyof JobHooks, run: () => void) => void;
  notify: (row: JobRow) => void;
}

/** Stores how an attempt ended: succeeded, cancelled, waiting for a retry, failed or interrupted on quit. */
export class AttemptOutcomes {
  constructor(private readonly deps: AttemptOutcomeDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Puts a job interrupted on quit back to `pending`; `attempts` is the count before the interrupted attempt. */
  requeueInterrupted(job: JobRow, attempts: number): void {
    this.db
      .update(jobs)
      .set({ status: 'pending', attempts: Math.max(0, attempts), progressMessage: INTERRUPTED_JOB_MESSAGE, startedAt: null })
      .where(eq(jobs.id, job.id))
      .run();
    this.deps.ctx.logger.info('jobs', `Job interrupted on quit: ${job.type}`, { jobId: job.id });
    const row = this.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    if (row) this.deps.notify(row);
  }

  settle(attempt: FinishedAttempt, outcome: Outcome): void {
    const { job, attempts, registered } = attempt;
    if (outcome.ok) {
      this.db
        .update(jobs)
        .set({ status: 'succeeded', progress: 1, progressMessage: null, result: (outcome.result ?? null) as ArchivistJson | null, finishedAt: nowIso() })
        .where(eq(jobs.id, job.id))
        .run();
      return;
    }
    if (!isJobCancelled(outcome.error) && !attempt.isCancelled()) {
      this.recordFailure(attempt, outcome.error);
      return;
    }
    // whatever the handler threw after a cancel request (e.g. an aborted LLM request): the job was cancelled
    this.db.update(jobs).set({ status: 'cancelled', progressMessage: null, finishedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
    this.deps.ctx.logger.info('jobs', `Job cancelled: ${job.type}`, { jobId: job.id, attempts });
    this.deps.runHook(job.type, 'onCancelled', () => registered?.hooks.onCancelled?.({ id: job.id, payload: job.payload as never }));
  }

  /** A failed attempt: retryable errors wait (exponential backoff) for the next attempt, otherwise the job fails. */
  private recordFailure(attempt: FinishedAttempt, err: unknown): void {
    const { job, attempts, registered } = attempt;
    const info = toErrorInfo(err);
    const error = `${info.message}${info.details ? ` – ${info.details}` : ''}`;
    if (info.retryable && attempts < job.maxAttempts) {
      const delay = this.deps.retryDelay(attempts);
      this.deps.retryWaits.set(job.id, Date.now() + delay);
      this.deps.ctx.logger.warn('jobs', `Job failed, retrying: ${job.type}`, { jobId: job.id, error: err, attempts, delayMs: delay });
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
    this.deps.ctx.logger.error('jobs', `Job failed: ${job.type}`, { jobId: job.id, error: err, attempts });
    this.db.update(jobs).set({ status: 'failed', error, progressMessage: null, finishedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
    this.deps.runHook(job.type, 'onFailed', () => registered?.hooks.onFailed?.({ id: job.id, payload: job.payload as never, attempts }, err));
  }
}
