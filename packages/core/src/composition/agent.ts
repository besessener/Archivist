import { AgentService } from '../agent/service';
import { AgentFileJobs } from '../agent/file-jobs';
import type { Job } from '@archivist/shared';
import { DiagnosticsService } from '../services/diagnostics/diagnostics';
import { ExcludedLocations } from '../services/diagnostics/excluded-locations';
import { LogReader } from '../services/diagnostics/log-reader';
import type { WiredServices } from './domain-services';

/** The agent and its file jobs; large file operations of a run are jobs of their own under the run id (#304). */
export function createAgent(services: WiredServices, enqueueConsistency: (trigger: string) => Job, environment: { appVersion: string }) {
  const { ctx, jobs, archive, agentRuns, llm, appState, memory } = services;
  const agentFileJobs = new AgentFileJobs({ jobs, archive, runs: agentRuns });
  agentFileJobs.register();
  const excluded = new ExcludedLocations({ settings: services.settings, privacy: services.privacy, docs: services.documents, scanner: services.scanner });
  const logReader = new LogReader({ paths: services.paths, logger: ctx.logger, excluded });
  const diagnostics = new DiagnosticsService({ ctx, settings: services.settings, llm, excluded, appVersion: environment.appVersion });
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
      contradictions: services.contradictions,
      memory,
      fileJobs: agentFileJobs,
      links: services.links,
      logger: ctx.logger,
      logs: logReader,
      diagnostics,
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
  return { agent, agentFileJobs, logReader, diagnostics };
}
