import { AgentService } from '../agent/service';
import { AgentFileJobs } from '../agent/file-jobs';
import type { Job } from '@archivist/shared';
import type { WiredServices } from './domain-services';

/** The agent and its file jobs; large file operations of a run are jobs of their own under the run id (#304). */
export function createAgent(services: WiredServices, enqueueConsistency: (trigger: string) => Job) {
  const { ctx, jobs, archive, agentRuns, llm, appState, memory } = services;
  const agentFileJobs = new AgentFileJobs({ jobs, archive, runs: agentRuns });
  agentFileJobs.register();
  const agent = new AgentService({
    ctx,
    tools: {
      paths: services.paths,
      settings: services.settings,
      docs: services.documents,
      search: services.search,
      graph: services.graph,
      privacy: services.privacy,
      decisions: services.decisions,
      openItems: services.openItems,
      reminders: services.reminders,
      events: services.eventRecords,
      notes: services.notes,
      timeline: services.timeline,
      insights: services.insights,
      actions: services.actions,
      archive,
      categories: services.categories,
      scanner: services.scanner,
      jobs,
      audit: services.audit,
      undo: services.undo,
      persons: services.persons,
      notifications: services.notifications,
      openItemDuplicates: services.openItemDuplicates,
      noteEventDuplicates: services.noteEventDuplicates,
      memory,
      fileJobs: agentFileJobs,
      links: services.links,
      logger: ctx.logger,
      subjects: services.subjects,
      cases: services.cases,
      linkThresholds: services.linkThresholds,
      capture: services.capture,
      answers: services.answers,
      enqueueConsistency,
    },
    llm,
    runs: agentRuns,
    appState,
    memory,
  });
  return { agent, agentFileJobs };
}
