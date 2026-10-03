import type { Job } from '@archivist/shared';
import type { Logger } from '../util/logger';
import { runBounded } from '../util/bounded';
import type { JobContext, JobQueueService } from './jobs';

/** Job type that re-indexes the records a merge or a bulk change touched. */
export const REINDEX_REFS_JOB = 'search.reindex-refs';

/** Records re-indexed at the same time: a remote embedding endpoint must not get a burst of requests (#224). */
export const REINDEX_CONCURRENCY = 2;

export interface ReindexRefs {
  documents: string[];
  decisions: string[];
  openItems: string[];
  events: string[];
}

type Reindexers = Record<keyof ReindexRefs, (id: string) => Promise<void>>;

/** Queues the re-indexing of `refs`; null if there is nothing to index. */
export function enqueueReindexRefs(jobs: JobQueueService, refs: ReindexRefs): Job | null {
  const count = refs.documents.length + refs.decisions.length + refs.openItems.length + refs.events.length;
  if (count === 0) return null;
  return jobs.enqueue(REINDEX_REFS_JOB, { label: count === 1 ? '1 Eintrag neu indizieren' : `${count} Einträge neu indizieren`, payload: refs });
}

/** Re-indexes the records with bounded concurrency; resumes after a restart where the last finished batch ended. */
export async function reindexRefs(deps: { reindexers: Reindexers; logger: Logger }, job: JobContext<ReindexRefs>): Promise<{ summary: string }> {
  const entries = (Object.keys(deps.reindexers) as Array<keyof ReindexRefs>).flatMap((kind) => job.payload[kind].map((id) => ({ kind, id })));
  const start = (job.checkpoint as { done?: number } | null)?.done ?? 0;
  const errors = await runBounded(
    entries,
    {
      limit: REINDEX_CONCURRENCY,
      start,
      onBatchDone: (done) => {
        job.throwIfCancelled();
        job.saveCheckpoint({ done });
        job.report(done / entries.length, `${done} von ${entries.length} Einträgen indiziert`);
      },
    },
    ({ kind, id }) => deps.reindexers[kind](id),
  );
  for (const error of errors) deps.logger.warn('search', 'Reindexing after a bulk change failed', { error });
  return { summary: `${entries.length - errors.length} von ${entries.length} Einträgen indiziert` };
}
