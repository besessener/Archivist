import type { Job } from '@archivist/shared';
import type { AgentService } from '../agent/service';
import { NEAR_DUPLICATE_BACKFILL_JOB } from '../services/near-duplicates';
import { enqueueReembedding } from '../services/reembedding';
import { maskingOf } from '../util/redact';
import type { WiredServices } from './domain-services';

type LifecycleServices = WiredServices & {
  agent: AgentService;
  enqueueConsistency: (trigger: string) => Job;
  enqueueLinkRun: (trigger: string) => Job;
};

const TRANSMISSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Longest wait on running archive file operations when quitting; stays below the desktop's 10 s quit deadline (QUIT_DEADLINE_MS). */
const ARCHIVE_DRAIN_TIMEOUT_MS = 8_000;

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
      logger.setMasking(maskingOf(settings.get()));
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

/** Remote vectors from before local ones were kept next to them get theirs once after the update (#173). */
function addMissingLocalVectors({ appState, search, jobs }: LifecycleServices): void {
  if (appState.get('search.local-vectors.v1')) return;
  appState.set('search.local-vectors.v1', new Date().toISOString());
  if (search.hasRemoteVectorsWithoutLocal()) enqueueReembedding(jobs);
}

/** Documents from before the near-duplicate signatures get theirs once, in a resumable job (#230). */
function signExistingDocuments({ appState, jobs }: LifecycleServices): void {
  if (appState.get('documents.near-duplicates.v1')) return;
  appState.set('documents.near-duplicates.v1', new Date().toISOString());
  jobs.enqueue(NEAR_DUPLICATE_BACKFILL_JOB, { label: 'Dokumente auf ähnlichen Inhalt vergleichen', sameAs: () => true });
}

function startAgent({ agent, jobs, chat }: LifecycleServices): void {
  agent.start({
    enqueue: (kind, docIds) =>
      jobs.enqueue('agent.background', { label: `Hintergrund-Agent: ${BACKGROUND_LABEL[kind] ?? 'Ablauf'}`, payload: { kind, docIds }, maxAttempts: 2 }),
    post: (message) => chat.postAssistant(message),
  });
}

function startupBackup({ settings, backup, logger }: WiredServices): void {
  if (!settings.get().backups.autoOnStartup) return;
  void backup
    .create({ includeArchive: settings.get().backups.includeArchive, trigger: 'startup' })
    .catch((err) => logger.warn('backup', 'Automatic backup failed', { error: err }));
}

export function createLifecycle(services: LifecycleServices) {
  const { logger, settings, llm, documents, jobs, reminders, self, scanner, archive, agent, consistency, pool, reader, database } = services;
  let pruneTimer: NodeJS.Timeout | null = null;
  const pruneTransmissions = () => {
    try {
      llm.pruneTransmissions();
    } catch (err) {
      logger.warn('llm', 'Pruning the transmission log failed', { error: err });
    }
  };
  return {
    /** Starts background work (only while the application runs). */
    start(): void {
      logger.prune(settings.get().logs.retentionDays);
      pruneTransmissions();
      pruneTimer = setInterval(pruneTransmissions, TRANSMISSION_PRUNE_INTERVAL_MS);
      pruneTimer.unref();
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
      addMissingLocalVectors(services);
      signExistingDocuments(services);
      startAgent(services);
      startupBackup(services);
    },

    /** Stops background work and closes the database after interrupted jobs (5 s) and running file operations (8 s) were awaited. */
    async shutdown(options: { jobTimeoutMs?: number; archiveTimeoutMs?: number } = {}): Promise<void> {
      if (pruneTimer) clearInterval(pruneTimer);
      reminders.stop();
      agent.stop();
      scanner.stop();
      consistency.stopTimer();
      const drained = archive.drain(options.archiveTimeoutMs ?? ARCHIVE_DRAIN_TIMEOUT_MS);
      await jobs.interrupt(options.jobTimeoutMs);
      if (!(await drained)) logger.warn('archive', 'Quit while archive file operations were still running');
      await pool.close();
      await reader.close();
      database.close();
      await logger.close();
    },
  };
}
