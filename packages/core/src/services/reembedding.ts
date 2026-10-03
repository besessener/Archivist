import type { EntityType, Job } from '@archivist/shared';
import { AppError } from '../util/errors';
import type { EmbeddingService } from './embedding';
import type { JobContext, JobQueueService } from './jobs';
import { REEMBED_JOB, type SearchService } from './search';

type IndexedEntry = { id: string; type: EntityType };

export interface ReembeddingDeps {
  search: SearchService;
  embedding: EmbeddingService;
  documentGoesRemote: (documentId: string) => boolean;
  reindex: (entry: IndexedEntry) => Promise<void>;
}

/** Queues re-embedding (#173): a waiting job covers the request, a running one may still use the previous model. */
export function enqueueReembedding(jobs: JobQueueService): Job {
  return jobs.enqueue(REEMBED_JOB, { label: 'Einträge neu einbetten', sameAs: (_payload, status) => status === 'pending' });
}

/** Moves the entries onto the current model; fails (retryable) while entries that should be remote kept local vectors only. */
export async function reembedEntries(deps: ReembeddingDeps, job: JobContext<Record<string, never>>): Promise<{ summary: string }> {
  const { search, documentGoesRemote } = deps;
  const model = deps.embedding.currentModel({ allowRemote: true });
  const stale = search.entriesWithOtherModel(model, documentGoesRemote);
  for (const [index, entry] of stale.entries()) {
    job.signal.throwIfAborted();
    job.report(index / stale.length, `${index} von ${stale.length} neu eingebettet`);
    await deps.reindex(entry);
  }
  // the embedding service falls back to local vectors silently when the endpoint is down
  const left = new Set(search.entriesWithOtherModel(model, documentGoesRemote).map((entry) => entry.id));
  const moved = stale.filter((entry) => !left.has(entry.id)).length;
  if (moved < stale.length)
    throw new AppError('llm_error', `Nur ${moved} von ${stale.length} Einträgen neu eingebettet: Das Embedding-Modell war nicht erreichbar.`, {
      retryable: true,
    });
  return { summary: moved === 1 ? '1 Eintrag neu eingebettet' : `${moved} Einträge neu eingebettet` };
}
