import { ACTIVE_DECISION_STATUSES, type Decision } from '@archivist/shared';
import type { JobContext, JobQueueService } from './jobs';

/** Job type of the check of one saved decision: saving never waits for the LLM's reviews. */
export const CONTRADICTION_CHECK_JOB = 'contradiction.check';

export interface ContradictionCheckPayload {
  decisionId: string;
}

/** Queues the check of an active decision; a check of it that has not started yet covers this change as well. */
export function queueContradictionCheck(jobs: Pick<JobQueueService, 'enqueue'>, decision: Pick<Decision, 'id' | 'status'>): void {
  if (!ACTIVE_DECISION_STATUSES.includes(decision.status)) return;
  jobs.enqueue<ContradictionCheckPayload>(CONTRADICTION_CHECK_JOB, {
    label: 'Entscheidung auf Widersprüche prüfen',
    payload: { decisionId: decision.id },
    sameAs: (queued, status) => status === 'pending' && queued.decisionId === decision.id,
  });
}

// narrow views: naming the services' classes would close an import cycle through the action executors
interface CheckDeps {
  decisions: { count(filter: { ids: string[] }): number };
  contradictions: { checkDecision(decisionId: string, signal: AbortSignal): Promise<unknown[]> };
}

/** Runs a queued check; a decision deleted in the meantime leaves nothing to check. */
export async function runContradictionCheck({ decisions, contradictions }: CheckDeps, job: JobContext<ContradictionCheckPayload>) {
  const { decisionId } = job.payload;
  if (decisions.count({ ids: [decisionId] }) === 0) return { summary: 'Die Entscheidung gibt es nicht mehr.' };
  const found = await contradictions.checkDecision(decisionId, job.signal);
  return { summary: found.length === 1 ? '1 möglicher Widerspruch' : `${found.length} mögliche Widersprüche` };
}
