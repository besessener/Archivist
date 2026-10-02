import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { jobs } from '../../db/schema';
import type { ArchivistJson } from '../../util/json';

import { JobCancelledError } from './job-errors';
import { storedCheckpoint, type JobRow } from './job-rows';
import type { JobContext } from './job-types';

/** What a running attempt's context needs from the queue. */
export interface AttemptScope {
  job: JobRow;
  attempts: number;
  controller: AbortController;
  ctx: AppContext;
  /** true once `interrupt` gave the job up: nothing the handler does afterwards is recorded */
  isAbandoned: () => boolean;
  notify: (row: JobRow) => void;
}

/** The context handed to a job handler for one attempt (progress, checkpoint, cancellation). */
export function createJobContext(scope: AttemptScope): JobContext<unknown> {
  const { job, attempts, controller, isAbandoned, notify } = scope;
  const db = () => scope.ctx.database.db;
  const isCancelled = () =>
    controller.signal.aborted || Boolean(db().select({ cancelRequested: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, job.id)).get()?.cancelRequested);
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    attempts,
    report: (progress: number | null, message?: string) => {
      if (isAbandoned()) return;
      db()
        .update(jobs)
        .set({ progress, progressMessage: message ?? null })
        .where(eq(jobs.id, job.id))
        .run();
      notify({ ...job, status: 'running', progress, progressMessage: message ?? null });
    },
    isCancelled,
    checkpoint: storedCheckpoint(job.result),
    saveCheckpoint: (data: unknown) => {
      if (isAbandoned()) return;
      db()
        .update(jobs)
        .set({ result: { checkpoint: (data ?? null) as ArchivistJson } })
        .where(eq(jobs.id, job.id))
        .run();
    },
    throwIfCancelled: () => {
      if (!isCancelled()) return;
      // the signal's reason tells a cancellation from an interruption on quit
      throw controller.signal.reason instanceof JobCancelledError ? controller.signal.reason : new JobCancelledError();
    },
    signal: controller.signal,
  };
}
