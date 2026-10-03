import type { AgentService } from '../agent/service';
import type { WiredServices } from './domain-services';
import { chatLinkCallbacks, type LinkProposalNotifier } from './link-automation';

type ReindexRefs = { documents: string[]; decisions: string[]; openItems: string[]; events: string[] };

/** Resolves the cyclic dependencies between services once all of them exist. */
export function wireServices(services: WiredServices & { agent: AgentService }, notifyLinkProposals: LinkProposalNotifier): void {
  const { actions, archive, documents, decisions, openItems, insights, contradictions, chat, capture, agent, graph, subjects, eventRecords } = services;
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
  const reindexRefs = async (refs: ReindexRefs) => {
    await Promise.all([
      ...refs.documents.map((id) => documents.indexDocument(id)),
      ...refs.decisions.map((id) => decisions.reindex(id)),
      ...refs.openItems.map((id) => openItems.reindex(id)),
      ...refs.events.map((id) => eventRecords.reindex(id)),
    ]);
  };
  graph.setReindexer(reindexRefs);
  subjects.setReindexer(reindexRefs);
}
