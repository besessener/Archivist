import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Run scope (#299): every change made while a tool of an agent run executes carries the run id – audit entries
 * (files, metadata, knowledge entries) and relations. Services read it from here, so no service needs a new parameter.
 */
export interface AgentRunScope {
  runId: string;
  /** true while a tool runs that the user explicitly asked for (links: confirmed instead of proposed, Epic #294). */
  explicit: boolean;
  /** Audit ids written while the current tool step runs (undo per step). */
  auditIds: string[];
}

export const agentRunScope = new AsyncLocalStorage<AgentRunScope>();

export const currentRun = (): AgentRunScope | undefined => agentRunScope.getStore();
