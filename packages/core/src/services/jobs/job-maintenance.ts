import { and, eq, inArray, lt } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { jobs } from '../../db/schema';
import { nowIso } from '../../util/ids';
import type { JobHooks, Registration } from './job-types';

/** Error of a job that was running when the app ended unexpectedly and has no attempt left. */
export const CRASHED_JOB_ERROR = 'Die App wurde während dieses Jobs unerwartet beendet; es ist kein weiterer Versuch übrig.';

/** Finished jobs (succeeded, failed, cancelled) are removed after this many days. */
export const JOB_RETENTION_DAYS = 30;

/** Jobs a crash left `running` are requeued (at least once, even with `maxAttempts` 1) or fail; returns how many were requeued. */
export function recoverCrashedJobs(
  ctx: AppContext,
  options: { handlers: Map<string, Registration>; runHook: (target: { type: string; hook: keyof JobHooks }, run: () => void) => void },
): number {
  const { db } = ctx.database;
  let requeued = 0;
  for (const row of db.select().from(jobs).where(eq(jobs.status, 'running')).all()) {
    if (row.attempts < Math.max(row.maxAttempts, 2)) {
      db.update(jobs).set({ status: 'pending', progressMessage: 'Nach Neustart fortgesetzt' }).where(eq(jobs.id, row.id)).run();
      requeued += 1;
      continue;
    }
    ctx.logger.error('jobs', `Job crashed without attempts left: ${row.type}`, { jobId: row.id, attempts: row.attempts });
    db.update(jobs).set({ status: 'failed', error: CRASHED_JOB_ERROR, progressMessage: null, finishedAt: nowIso() }).where(eq(jobs.id, row.id)).run();
    const hooks = options.handlers.get(row.type)?.hooks;
    options.runHook({ type: row.type, hook: 'onFailed' }, () =>
      hooks?.onFailed?.({ id: row.id, payload: row.payload as never, attempts: row.attempts }, new Error(CRASHED_JOB_ERROR)),
    );
  }
  return requeued;
}

/** Removes finished jobs older than `JOB_RETENTION_DAYS`. Returns the number of removed jobs. */
export function pruneFinishedJobs(ctx: AppContext, now: number): number {
  const cutoff = new Date(now - JOB_RETENTION_DAYS * 86_400_000).toISOString();
  const removed = ctx.database.db
    .delete(jobs)
    .where(and(inArray(jobs.status, ['succeeded', 'failed', 'cancelled']), lt(jobs.finishedAt, cutoff)))
    .run().changes;
  if (removed) ctx.logger.info('jobs', 'Old jobs removed', { removed });
  return removed;
}
