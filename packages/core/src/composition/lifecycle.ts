import type { Job } from '@archivist/shared';
import type { AgentService } from '../agent/service';
import type { WiredServices } from './domain-services';

type LifecycleServices = WiredServices & {
  agent: AgentService;
  enqueueConsistency: (trigger: string) => Job;
  enqueueLinkRun: (trigger: string) => Job;
};

const BACKGROUND_LABEL: Record<string, string> = { inbox: 'Eingang sortieren', archive_check: 'Agentische Archivprüfung', links: 'Verknüpfungen pflegen' };

function syncOwnPerson({ self, logger }: WiredServices): void {
  self.syncProfile().catch((err: unknown) => logger.warn('persons', 'Own person not adjusted', { error: err }));
}

/** Changed settings or scan folders re-plan the schedules; an unchanged plan keeps its timer. */
export function reactToSettingsChanges(services: WiredServices): void {
  const { events, logger, settings, consistency, scanner } = services;
  events.on('data:changed', (change: { scopes: string[] }) => {
    if (change.scopes.includes('settings')) {
      logger.setLevel(settings.get().logs.level);
      consistency.applySettings();
      // a new profile name renames the own person or merges a person with that name into it
      syncOwnPerson(services);
    }
    if (change.scopes.includes('settings') || change.scopes.includes('scanner')) scanner.applySettings();
  });
}

/** Checks the KI connection right away for the status bar, but only when external transmission is allowed at all. */
function checkLlmOnStartup({ llm, logger }: WiredServices): void {
  if (!llm.canUse()) return;
  void llm.testConnection().then((result) => {
    if (!result.ok) logger.warn('llm', 'Connection check on startup failed', { error: result.message });
  });
}

function scheduleArchiveChecks(services: LifecycleServices): void {
  const { settings, consistency, enqueueConsistency } = services;
  const startupCheck = settings.get().consistency.onStartup;
  if (startupCheck) enqueueConsistency('startup');
  consistency.startTimer(() => enqueueConsistency('interval'), { startupCheckQueued: startupCheck });
}

/** The retroactive link run starts once after the update that brought it (#279); later only on request or by the agent. */
function startInitialLinkRun({ appState, links, enqueueLinkRun }: LifecycleServices): void {
  if (appState.get('links.run.initial.v2')) return;
  appState.set('links.run.initial.v2', new Date().toISOString());
  links.restartBackfill();
  enqueueLinkRun('update');
}

function startAgent({ agent, jobs, chat }: LifecycleServices): void {
  agent.start({
    enqueue: (kind, docIds) =>
      jobs.enqueue('agent.background', `Hintergrund-Agent: ${BACKGROUND_LABEL[kind] ?? 'Ablauf'}`, { kind, docIds }, { maxAttempts: 2 }),
    post: (title, content, existing) => chat.postAssistant(title, content, existing),
  });
}

function startupBackup({ settings, backup, logger }: WiredServices): void {
  if (!settings.get().backups.autoOnStartup) return;
  void backup.create(settings.get().backups.includeArchive, 'startup').catch((err) => logger.warn('backup', 'Automatic backup failed', { error: err }));
}

export function createLifecycle(services: LifecycleServices) {
  const { logger, settings, documents, jobs, reminders, self, scanner, archive, agent, consistency, pool, reader, database } = services;
  return {
    /** Starts background work (only while the application runs). */
    start(): void {
      logger.prune(settings.get().logs.retentionDays);
      // before the queue resumes: documents stuck in `analyzing` without a job become `failed` (reprocessable)
      documents.recoverInterruptedAnalyses();
      jobs.start();
      reminders.start();
      // exactly one own person („Du“), renamed to the profile name if that changed meanwhile
      self.ensure();
      syncOwnPerson(services);
      checkLlmOnStartup(services);
      scanner.startSchedule();
      scanner.startupScan();
      void archive.cleanupInbox();
      scheduleArchiveChecks(services);
      startInitialLinkRun(services);
      startAgent(services);
      startupBackup(services);
    },

    /** Stops background work and closes the database; waits at most `jobTimeoutMs` (default 5 s) for interrupted jobs. */
    async shutdown(options: { jobTimeoutMs?: number } = {}): Promise<void> {
      reminders.stop();
      agent.stop();
      scanner.stop();
      consistency.stopTimer();
      await jobs.interrupt(options.jobTimeoutMs);
      await pool.close();
      await reader.close();
      database.close();
      await logger.close();
    },
  };
}
