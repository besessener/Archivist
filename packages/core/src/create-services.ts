import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService, type MigrationStatus } from './db/database';
import { EventBus, ensureDataDirs, resolveDataPaths, type AppContext } from './context';
import { ActionService } from './services/actions';
import { ArchiveService } from './services/archive';
import { AuditService } from './services/audit';
import { BackupService } from './services/backup';
import { CategoryService } from './services/categories';
import { ChatService } from './services/chat';
import { ConsistencyService } from './services/consistency';
import { ContradictionService } from './services/contradictions';
import { DecisionService } from './services/decisions';
import { DocumentService } from './services/documents';
import { EmbeddingService } from './services/embedding';
import { InsightService } from './services/insights';
import { JobQueueService } from './services/jobs';
import { KnowledgeGraphService } from './services/knowledge-graph';
import { LlmService, type FetchLike } from './services/llm';
import { NotificationService } from './services/notifications';
import { EventService } from './services/events';
import { OpenItemService } from './services/open-items';
import { PrivacyService } from './services/privacy';
import { ReminderService } from './services/reminders';
import { ScannerService } from './services/scanner';
import { SearchService } from './services/search';
import { SecretService, type SecretCipher } from './services/secret';
import { SettingsService, settingsLoadNotification } from './services/settings';
import { SolutionService } from './services/solutions';
import { TimelineService } from './services/timeline';
import { UndoService } from './services/undo';
import { Logger } from './util/logger';
import { WorkerPool } from './workers/pool';

export interface CreateServicesOptions {
  /** Wurzel der lokalen Datenhaltung (Standard: ~/Documents/Archivist) */
  dataRoot: string;
  /** Ordner mit den Drizzle-Migrationen */
  migrationsFolder: string;
  cipher: SecretCipher;
  /** Pfad zum gebündelten Worker-Skript; null/undefined = Aufgaben laufen inline (Tests) */
  workerFile?: string | null;
  fetchImpl?: FetchLike;
  jobConcurrency?: number;
  /** Wait before the first job retry; doubles with every further attempt (default 5 s, tests: 0) */
  jobRetryDelayMs?: number;
  /** Wartezeit zwischen LLM-Wiederholungen (Tests: 0) */
  llmRetryDelayMs?: number;
}

export type Services = ReturnType<typeof buildServices>;

/** Kompositionswurzel: erzeugt und verdrahtet alle Services. */
export function createServices(opts: CreateServicesOptions) {
  return buildServices(opts);
}

function buildServices(opts: CreateServicesOptions) {
  // 1) Verzeichnisstruktur + Einstellungen
  const baseline = resolveDataPaths(opts.dataRoot);
  ensureDataDirs(baseline);
  const events = new EventBus();
  const settings = new SettingsService(path.join(baseline.config, 'settings.json'), baseline.archive, events);
  const paths = resolveDataPaths(opts.dataRoot, settings.get().archiveRoot);
  fs.mkdirSync(paths.archive, { recursive: true });

  // 2) Logging, Datenbank, Migrationen
  const logger = new Logger(paths.logs, settings.get().logs.level);
  const database = new DatabaseService(path.join(paths.database, 'archivist.db'), logger);
  const migration: MigrationStatus = database.migrate(opts.migrationsFolder);
  logger.info('app', 'Datenbank bereit', { migrations: migration });
  const ctx: AppContext = { paths, database, logger, events };

  // 3) Basisdienste
  const secrets = new SecretService(path.join(paths.config, 'llm-api-key.enc'), opts.cipher, logger);
  const audit = new AuditService(ctx);
  const undo = new UndoService(ctx, audit);
  const pool = new WorkerPool(opts.workerFile ?? null);
  const llm = new LlmService(ctx, settings, secrets, opts.fetchImpl, opts.llmRetryDelayMs);
  const privacy = new PrivacyService(settings);
  const embedding = new EmbeddingService(settings, llm);
  const graph = new KnowledgeGraphService(ctx, audit, undo);
  const search = new SearchService(ctx, embedding, pool, () => privacy.mode() !== 'local_only' && llm.isConfigured());
  const categories = new CategoryService(ctx);
  const jobs = new JobQueueService(ctx, { concurrency: opts.jobConcurrency ?? 2, retryBaseDelayMs: opts.jobRetryDelayMs });
  const notifications = new NotificationService(ctx);
  const reminders = new ReminderService(ctx, notifications);
  // Settings are loaded before the database exists; report a repaired or unreadable settings.json now.
  const settingsProblem = settings.takeLoadProblem();
  if (settingsProblem) {
    logger.warn('settings', 'settings.json war ungültig und wurde repariert', { ...settingsProblem });
    notifications.create(settingsLoadNotification(settingsProblem));
  }

  // 4) Fachdienste
  const documentsSvc = new DocumentService(ctx, settings, graph, search, llm, privacy, pool, audit, notifications, categories, jobs, undo);
  const decisions = new DecisionService(ctx, graph, search, audit, undo);
  const openItems = new OpenItemService(ctx, graph, search, audit, undo);
  const eventsSvc = new EventService(ctx, graph, search, audit, undo);
  const insights = new InsightService(ctx);
  const actions = new ActionService(ctx);
  const contradictions = new ContradictionService(ctx, decisions, graph, insights, notifications, llm);
  const archive = new ArchiveService(ctx, settings, documentsSvc, categories, graph, audit, notifications, pool, undo);
  const scanner = new ScannerService(ctx, settings, pool, documentsSvc, graph, privacy, notifications, insights, audit, jobs);
  const timeline = new TimelineService(ctx, graph);
  const consistency = new ConsistencyService(ctx, settings, decisions, openItems, graph, contradictions, insights, notifications);
  const backup = new BackupService(ctx, settings, audit);
  const solutions = new SolutionService(ctx, settings, llm, privacy, openItems, decisions, documentsSvc, eventsSvc, graph, search, audit);
  const chat = new ChatService(
    ctx,
    settings,
    llm,
    decisions,
    openItems,
    reminders,
    search,
    graph,
    documentsSvc,
    scanner,
    contradictions,
    insights,
    timeline,
    jobs,
    privacy,
    eventsSvc,
  );

  // 5) zyklische Abhängigkeiten auflösen
  actions.wire({ archive, documents: documentsSvc, decisions, openItems, contradictions, graph, scanner, reminders, audit });
  insights.wire({ actions, reminders });
  contradictions.wire({ actions });
  archive.wire({ actions, openItems });
  chat.wire({ actions, archive });
  graph.setReindexer(async (refs) => {
    await Promise.all([
      ...refs.documents.map((id) => documentsSvc.indexDocument(id)),
      ...refs.decisions.map((id) => decisions.reindex(id)),
      ...refs.openItems.map((id) => openItems.reindex(id)),
      ...refs.events.map((id) => eventsSvc.reindex(id)),
    ]);
  });

  // 6) Job-Handler
  // A failed attempt keeps the document in `analyzing` while a retry follows; only after the last attempt
  // it becomes `failed` and the user is notified. Archived documents are never touched.
  jobs.register<{ documentId: string; allowLlm: boolean }>(
    'document.analyze',
    (job) => documentsSvc.analyze(job.payload.documentId, { allowLlm: job.payload.allowLlm, signal: job.signal, deferFailure: true }),
    {
      onFailed: (job, err) => {
        if (!documentsSvc.markAnalysisFailed(job.payload.documentId, err)) return;
        notifications.create({
          title: 'Dateiimport fehlgeschlagen',
          description: err instanceof Error ? err.message : String(err),
          type: 'import_failed',
          priority: 'high',
          affectedEntityIds: [job.payload.documentId],
          proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
          dedupeKey: `analyze-failed:${job.payload.documentId}:${(Date.now() / 60000) | 0}`,
        });
      },
      // e.g. cancelled while waiting for a retry: the document must not stay in `analyzing`
      onCancelled: (job) => void documentsSvc.markAnalysisCancelled(job.payload.documentId),
    },
  );
  jobs.register<{ rootId: string | null }>('scanner.scan', async (job) => {
    const summaries = await scanner.runScan(job.payload.rootId, job);
    // optional: neue Dateien automatisch analysieren (nur wenn ausdrücklich aktiviert und der Datenschutzmodus es erlaubt)
    const s = settings.get();
    if (s.scan.autoAnalyze && privacy.mode() === 'auto') {
      const ids = scanner
        .getResults({ limit: 2000 })
        .files.filter((f) => f.status === 'new' || f.status === 'changed')
        .filter((f) => f.llmStatus !== 'excluded')
        .map((f) => f.id);
      if (ids.length) jobs.enqueue('scanner.analyze', `Analysiere ${ids.length} neue Dateien`, { fileIds: ids, confirmLlm: false });
    }
    return summaries;
  });
  jobs.register<{ fileIds: string[]; confirmLlm: boolean }>('scanner.analyze', (job) => scanner.analyzeFiles(job.payload.fileIds, job.payload.confirmLlm, job));
  jobs.register<{ trigger?: string }>('consistency.check', async (job) => {
    await archive.cleanupInbox(); // retries inbox copies that were locked right after archiving
    return consistency.run(job.payload.trigger ?? 'manual', (p, m) => job.report(p, m), job.signal);
  });

  // 7) Reaktion auf geänderte Einstellungen
  events.on('data:changed', (e: { scopes: string[] }) => {
    if (e.scopes.includes('settings')) {
      logger.setLevel(settings.get().logs.level);
      scanner.applySettings();
    }
  });

  const enqueueConsistency = (trigger: string) => jobs.enqueue('consistency.check', 'Archivprüfung', { trigger }, { maxAttempts: 1 });

  return {
    paths,
    ctx,
    events,
    logger,
    migration,
    settings,
    secrets,
    database,
    audit,
    undo,
    pool,
    llm,
    privacy,
    embedding,
    graph,
    search,
    categories,
    jobs,
    notifications,
    reminders,
    documents: documentsSvc,
    decisions,
    openItems,
    solutions,
    eventRecords: eventsSvc,
    insights,
    actions,
    contradictions,
    archive,
    scanner,
    timeline,
    consistency,
    backup,
    chat,
    enqueueConsistency,

    /** Startet Hintergrundarbeit (nur solange die Anwendung läuft). */
    start(): void {
      logger.prune(settings.get().logs.retentionDays);
      // before the queue resumes: documents stuck in `analyzing` without a job become `failed` (reprocessable)
      documentsSvc.recoverInterruptedAnalyses();
      jobs.start();
      reminders.start();
      scanner.applySettings();
      scanner.startupScan();
      void archive.cleanupInbox();
      if (settings.get().consistency.onStartup) enqueueConsistency('startup');
      consistency.startTimer(() => enqueueConsistency('interval'));
      if (settings.get().backups.autoOnStartup)
        void backup
          .create(settings.get().backups.includeArchive, 'startup')
          .catch((err) => logger.warn('backup', 'Automatisches Backup fehlgeschlagen', { error: err }));
    },

    async shutdown(): Promise<void> {
      reminders.stop();
      scanner.stop();
      consistency.stopTimer();
      await jobs.stop();
      await pool.close();
      database.close();
      await logger.close();
    },
  };
}
