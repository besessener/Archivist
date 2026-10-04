import type { AgentService } from '../agent/service';
import type { WiredServices } from './domain-services';
import { enqueueReembedding } from '../services/reembedding';
import { enqueueReindexRefs, type ReindexRefs } from '../services/reindex-refs';
import { chatLinkCallbacks, type LinkProposalNotifier } from './link-automation';

/** Resolves the cyclic dependencies between services once all of them exist. */
export function wireServices(services: WiredServices & { agent: AgentService }, notifyLinkProposals: LinkProposalNotifier): void {
  const { actions, archive, documents, openItems, insights, contradictions, chat, capture, agent, graph, subjects, jobs, search, decisions } = services;
  actions.wire({
    archive,
    documents,
    decisions,
    openItems,
    openItemDuplicates: services.openItemDuplicates,
    contradictions,
    graph,
    noteEventDuplicates: services.noteEventDuplicates,
    scanner: services.scanner,
    reminders: services.reminders,
    notifications: services.notifications,
    audit: services.audit,
    undo: services.undo,
    jobs: services.jobs,
  });
  insights.wire({ actions, reminders: services.reminders });
  contradictions.wire({ actions });
  archive.wire({ actions, openItems, decisions });
  chat.wire({ actions, archive, agent, ...chatLinkCallbacks(services, notifyLinkProposals) });
  capture.wire({ actions });
  actions.setAgentBatchExecutor((params) => agent.executeBatch(params));
  const reindexRefs = (refs: ReindexRefs) => Promise.resolve(void enqueueReindexRefs(jobs, refs));
  // entries that got local vectors because the endpoint failed are moved onto the remote model once it works again
  search.onEmbeddingFallback(() => enqueueReembedding(jobs, { coveredBy: 'pending_or_running' }));
  graph.setReindexer(reindexRefs);
  subjects.setReindexer(reindexRefs);
}
