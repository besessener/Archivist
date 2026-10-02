import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService, type MigrationStatus } from './db/database';
import { EventBus, ensureDataDirs, resolveDataPaths, type AppContext } from './context';
import { ActionService } from './services/actions';
import { ArchiveService } from './services/archive';
import { ArchiveRootService } from './services/archive-root';
import { AuditService } from './services/audit';
import { BackupService } from './services/backup';
import { CategoryService } from './services/categories';
import { ChatService } from './services/chat';
import { EntityDuplicateCheck } from './services/cleanup/entity-duplicates';
import { AppStateService } from './services/app-state';
import { ConsistencyService } from './services/consistency';
import { SelfService } from './services/self';
import { PersonDuplicateService } from './services/cleanup/person-duplicates';
import { PersonQuestionService } from './services/cleanup/person-questions';
import { ContradictionService } from './services/contradictions';
import { DecisionService } from './services/decisions';
import { DocumentService } from './services/documents';
import { EmbeddingService } from './services/embedding';
import { InsightService } from './services/insights';
import { JobQueueService } from './services/jobs';
import { KnowledgeGraphService } from './services/knowledge-graph';
import { LlmService, type FetchLike } from './services/llm';
import { NoteService } from './services/notes';
import { NotificationService } from './services/notifications';
import { EventService } from './services/events';
import { NoteEventDuplicateService } from './services/cleanup/note-event-duplicates';
import { OpenItemDuplicateService } from './services/cleanup/open-item-duplicates';
import { OpenItemService } from './services/open-items';
import { PersonService } from './services/persons';
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
  /** Root of the local data storage (default: ~/Documents/Archivist) */
  dataRoot: string;
  /** Folder with the Drizzle migrations */
  migrationsFolder: string;
  cipher: SecretCipher;
  /** Path to the bundled worker script; null/undefined = tasks run inline (tests) */
  workerFile?: string | null;
  fetchImpl?: FetchLike;
  jobConcurrency?: number;
  /** Wait before the first job retry; doubles with every further attempt (default 5 s, tests: 0) */
  jobRetryDelayMs?: number;
  /** Delay between LLM retries (tests: 0) */
  llmRetryDelayMs?: number;
}

export type Services = ReturnType<typeof buildServices>;

/** Composition root: creates and wires all services. */
export function createServices(opts: CreateServicesOptions) {
  return buildServices(opts);
}

function buildServices(opts: CreateServicesOptions) {
  // 1) directory structure + settings
  const baseline = resolveDataPaths(opts.dataRoot);
  ensureDataDirs(baseline);
  const events = new EventBus();
  const settings = new SettingsService(path.join(baseline.config, 'settings.json'), baseline.archive, events);
  const paths = resolveDataPaths(opts.dataRoot, settings.get().archiveRoot);
  fs.mkdirSync(paths.archive, { recursive: true });

  // 2) logging, database, migrations
  const logger = new Logger(paths.logs, settings.get().logs.level);
  const database = new DatabaseService(path.join(paths.database, 'archivist.db'), logger);
  const migration: MigrationStatus = database.migrate(opts.migrationsFolder);
  logger.info('app', 'Database ready', { migrations: migration });
  const ctx: AppContext = { paths, database, logger, events };

  // 3) base services
  const secrets = new SecretService(path.join(paths.config, 'llm-api-key.enc'), opts.cipher, logger);
  const audit = new AuditService(ctx);
  const undo = new UndoService(ctx, audit);
  const pool = new WorkerPool(opts.workerFile ?? null);
  const llm = new LlmService(ctx, settings, secrets, opts.fetchImpl, opts.llmRetryDelayMs);
  const privacy = new PrivacyService(settings);
  const embedding = new EmbeddingService(settings, llm);
  const graph = new KnowledgeGraphService(ctx, audit, undo);
  const persons = new PersonService(ctx, graph);
  const self = new SelfService(ctx, settings, graph);
  persons.setSelfResolver(self.resolver);
  // Search queries go to the embedding endpoint only in mode „automatisch“ – „vorher fragen“ uses local vectors only.
  const search = new SearchService(ctx, embedding, pool, () => privacy.mode() === 'auto' && llm.isConfigured());
  const categories = new CategoryService(ctx);
  const jobs = new JobQueueService(ctx, { concurrency: opts.jobConcurrency ?? 2, retryBaseDelayMs: opts.jobRetryDelayMs });
  const notifications = new NotificationService(ctx);
  const reminders = new ReminderService(ctx, notifications, settings);
  // Settings are loaded before the database exists; report a repaired or unreadable settings.json now.
  const settingsProblem = settings.takeLoadProblem();
  if (settingsProblem) {
    logger.warn('settings', 'settings.json was invalid and has been repaired', { ...settingsProblem });
    notifications.create(settingsLoadNotification(settingsProblem));
  }

  // 4) domain services
  const documentsSvc = new DocumentService(ctx, settings, graph, persons, search, llm, privacy, pool, audit, notifications, categories, jobs, undo);
  const decisions = new DecisionService(ctx, graph, persons, search, audit, undo);
  const openItems = new OpenItemService(ctx, graph, persons, search, audit, undo);
  const eventsSvc = new EventService(ctx, graph, search, audit, undo);
  const notes = new NoteService(ctx, graph, search);
  const insights = new InsightService(ctx);
  const actions = new ActionService(ctx);
  const contradictions = new ContradictionService(ctx, decisions, graph, insights, notifications, llm);
  const archive = new ArchiveService(ctx, settings, documentsSvc, categories, graph, persons, audit, notifications, pool, undo);
  const archiveRoot = new ArchiveRootService(ctx, settings, archive, audit, notifications, jobs, undo);
  const scanner = new ScannerService(ctx, settings, pool, documentsSvc, graph, privacy, notifications, insights, audit, jobs);
  const timeline = new TimelineService(ctx, graph);
  const entityDuplicates = new EntityDuplicateCheck(ctx, insights, actions, llm, privacy);
  const appState = new AppStateService(ctx);
  const consistency = new ConsistencyService(
    ctx,
    settings,
    decisions,
    openItems,
    graph,
    contradictions,
    insights,
    notifications,
    entityDuplicates,
    appState.lastRunStore('consistency.lastRunAt'),
  );
  const backup = new BackupService(ctx, settings, audit);
  const openItemDuplicates = new OpenItemDuplicateService(ctx, openItems, graph, audit, undo, insights);
  consistency.addCheck((count) => {
    openItemDuplicates.check(count);
  });
  const personDuplicates = new PersonDuplicateService(ctx, settings, graph, insights, () => self.ownNameKeys());
  consistency.addCheck((count) => personDuplicates.check(count));
  const personQuestions = new PersonQuestionService(ctx, graph, insights, llm, privacy);
  consistency.addCheck((count) => personQuestions.check(count));
  const noteEventDuplicates = new NoteEventDuplicateService(ctx, graph, notes, eventsSvc, audit, undo, insights);
  consistency.addCheck((count) => {
    noteEventDuplicates.check(count);
  });
  const solutions = new SolutionService(ctx, settings, llm, privacy, openItems, decisions, documentsSvc, eventsSvc, graph, search, audit, notes);
  const chat = new ChatService(
    ctx,
    settings,
    llm,
    decisions,
    openItems,
    reminders,
    search,
    graph,
    persons,
    documentsSvc,
    scanner,
    contradictions,
    insights,
    timeline,
    jobs,
    privacy,
    eventsSvc,
    notes,
  );

  // 5) resolve cyclic dependencies
  actions.wire({
    archive,
    documents: documentsSvc,
    decisions,
    openItems,
    openItemDuplicates,
    contradictions,
    graph,
    noteEventDuplicates,
    scanner,
    reminders,
    audit,
    undo,
  });
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

  // 6) job handlers
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
    // optional: analyze new files automatically (only if explicitly enabled and the privacy mode allows it)
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

  // 7) reaction to changed settings
  // Schedules are re-planned on every change of settings or scan folders; an unchanged plan keeps its timer.
  events.on('data:changed', (e: { scopes: string[] }) => {
    if (e.scopes.includes('settings')) {
      logger.setLevel(settings.get().logs.level);
      consistency.applySettings();
      // a new profile name renames the own person or merges a person with that name into it
      self.syncProfile().catch((err: unknown) => logger.warn('persons', 'Own person not adjusted', { error: err }));
    }
    if (e.scopes.includes('settings') || e.scopes.includes('scanner')) scanner.applySettings();
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
    persons,
    self,
    search,
    categories,
    jobs,
    notifications,
    reminders,
    documents: documentsSvc,
    decisions,
    openItems,
    openItemDuplicates,
    solutions,
    eventRecords: eventsSvc,
    notes,
    noteEventDuplicates,
    personDuplicates,
    personQuestions,
    insights,
    actions,
    contradictions,
    archive,
    archiveRoot,
    scanner,
    timeline,
    consistency,
    appState,
    backup,
    chat,
    enqueueConsistency,

    /** Starts background work (only while the application runs). */
    start(): void {
      logger.prune(settings.get().logs.retentionDays);
      // before the queue resumes: documents stuck in `analyzing` without a job become `failed` (reprocessable)
      documentsSvc.recoverInterruptedAnalyses();
      jobs.start();
      reminders.start();
      // exactly one own person („Du“): created now, renamed to the profile name if that changed meanwhile
      self.ensure();
      self.syncProfile().catch((err: unknown) => logger.warn('persons', 'Own person not adjusted', { error: err }));
      scanner.startSchedule();
      scanner.startupScan();
      void archive.cleanupInbox();
      const startupCheck = settings.get().consistency.onStartup;
      if (startupCheck) enqueueConsistency('startup');
      consistency.startTimer(() => enqueueConsistency('interval'), { startupCheckQueued: startupCheck });
      if (settings.get().backups.autoOnStartup)
        void backup.create(settings.get().backups.includeArchive, 'startup').catch((err) => logger.warn('backup', 'Automatic backup failed', { error: err }));
    },

    /**
     * Stops background work and closes the database. Running jobs are interrupted and resume after the next start;
     * waits at most `jobTimeoutMs` for them (default 5 s), so quitting never hangs on a long scan or OCR.
     */
    async shutdown(opts: { jobTimeoutMs?: number } = {}): Promise<void> {
      reminders.stop();
      scanner.stop();
      consistency.stopTimer();
      await jobs.interrupt(opts.jobTimeoutMs);
      await pool.close();
      database.close();
      await logger.close();
    },
  };
}
