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
import { CaptureService } from './services/capture';
import { KnowledgeAnswerService } from './services/knowledge-answers';
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
import { LinkMethodsService } from './services/link-methods';
import { LlmService, type FetchLike } from './services/llm';
import { NoteService } from './services/notes';
import { NoteAnalysisService } from './services/note-analysis';
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
import { DbReader } from './workers/db-reader';
import { WorkerPool } from './workers/pool';
import { AgentService, type BackgroundKind } from './agent/service';
import { AgentRunService } from './agent/runs';
import { MemoryService } from './agent/memory';
import { registerCreatedUndo } from './agent/created-undo';
import { AgentFileJobs } from './agent/file-jobs';

export interface CreateServicesOptions {
  /** Root of the local data storage (default: ~/Documents/Archivist) */
  dataRoot: string;
  /** Folder with the Drizzle migrations */
  migrationsFolder: string;
  cipher: SecretCipher;
  /** Path to the bundled worker script; null/undefined = tasks run inline (tests) */
  workerFile?: string | null;
  /** Path to the bundled read worker (own read-only DB connection); null/undefined = queries run inline (tests) */
  readerFile?: string | null;
  fetchImpl?: FetchLike;
  jobConcurrency?: number;
  /** Wait before the first job retry; doubles with every further attempt (default 5 s, tests: 0) */
  jobRetryDelayMs?: number;
  /** Delay between LLM retries (tests: 0) */
  llmRetryDelayMs?: number;
}

export type Services = ReturnType<typeof buildServices>;

/** Job of the retroactive link run (#279). */
const LINK_RUN_JOB = 'links.run';
/** Job that analyses a new or edited note (#273). */
const NOTE_ANALYZE_JOB = 'notes.analyze';
/** Job that proposes similar entries for newly indexed ones (#271). */
const LINK_SIMILAR_JOB = 'links.similar';

/** Files per automatic analysis job after a scan (the same cap as a manual analysis). */
const AUTO_ANALYZE_BATCH = 500;

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
  const reader = new DbReader(database.db, { workerFile: opts.readerFile ?? null, databaseFile: database.file, logger });
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
  const eventsSvc = new EventService(ctx, graph, search, audit, persons, undo);
  const notes = new NoteService(ctx, graph, search, audit, undo);
  const noteAnalysis = new NoteAnalysisService(ctx, graph, persons, llm, privacy);
  const memory = new MemoryService(ctx);
  const agentRuns = new AgentRunService(ctx, audit, undo);
  registerCreatedUndo(ctx, undo, graph, search);
  const insights = new InsightService(ctx);
  const actions = new ActionService(ctx);
  const contradictions = new ContradictionService(ctx, decisions, graph, insights, notifications, llm);
  const archive = new ArchiveService(ctx, settings, documentsSvc, categories, graph, persons, audit, notifications, pool, undo);
  const archiveRoot = new ArchiveRootService(ctx, settings, archive, audit, notifications, jobs, undo);
  const scanner = new ScannerService(ctx, settings, pool, documentsSvc, graph, privacy, notifications, insights, audit, jobs);
  const timeline = new TimelineService(ctx);
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
  const backup = new BackupService(ctx, settings, audit, archive);
  const openItemDuplicates = new OpenItemDuplicateService(ctx, openItems, graph, audit, undo, insights);
  consistency.addCheck((count) => {
    openItemDuplicates.check(count);
  });
  const personDuplicates = new PersonDuplicateService(ctx, settings, graph, insights, () => self.ownNameKeys());
  consistency.setIndexRefresher((id, signal) => documentsSvc.refreshIndexedOnly(id, { signal }));
  consistency.addCheck((count) => personDuplicates.check(count));
  const personQuestions = new PersonQuestionService(ctx, graph, insights, llm, privacy);
  consistency.addCheck((count) => personQuestions.check(count));
  const noteEventDuplicates = new NoteEventDuplicateService(ctx, graph, notes, eventsSvc, audit, undo, insights);
  consistency.addCheck((count) => {
    noteEventDuplicates.check(count);
  });
  const solutions = new SolutionService(ctx, settings, llm, privacy, openItems, decisions, documentsSvc, eventsSvc, graph, search, audit, notes);
  // capturing knowledge and verified answers: one module each for the agent tools and the rule-based chat (#307)
  const capture = new CaptureService(ctx, settings, decisions, openItems, reminders, graph, persons, contradictions, insights, notes, eventsSvc);
  const answers = new KnowledgeAnswerService(settings, llm, decisions, openItems, search, graph, documentsSvc, privacy, eventsSvc);
  const chat = new ChatService(
    ctx,
    settings,
    llm,
    decisions,
    openItems,
    search,
    graph,
    documentsSvc,
    scanner,
    contradictions,
    insights,
    timeline,
    jobs,
    capture,
    answers,
  );

  // the fixed link methods (Epic #269) – the same functions for the UI and the agent tools (#313)
  const links = new LinkMethodsService(ctx, graph, search, insights, appState);
  /**
   * ONE notification for open link proposals, only when new ones came up (#280): while the current one is unread it is
   * updated in place; once it was read or dismissed, the next new proposals bring a new one.
   */
  const notifyLinkProposals = (created: number) => {
    if (created <= 0) return;
    const open = links.proposals({ limit: 1 }).total;
    if (!open) return;
    let key = appState.get('links.notification.key');
    const current = key ? notifications.byDedupeKey(key) : null;
    if (!key || current?.readAt || current?.resolvedAt) {
      key = `link-proposals:${Date.now()}`;
      appState.set('links.notification.key', key);
    }
    notifications.create({
      title: 'Verknüpfungsvorschläge',
      description: `${open === 1 ? 'Ein Vorschlag wartet' : `${open} Vorschläge warten`} auf deine Prüfung. Du entscheidest, was übernommen wird.`,
      type: 'assignment_proposal',
      priority: 'low',
      proposedActions: [{ label: 'Vorschläge prüfen', kind: 'navigate', target: '/insights/' }],
      dedupeKey: key,
    });
  };
  // after every new or changed entry: look for similar ones in a job of its own, never on the caller's path (#271)
  search.onIndexed(({ id }) => {
    if (!settings.get().links.autoPropose || !links.queueSimilar([id])) return;
    // a job that has not started yet takes the entry along; a running one picks it up before it ends
    jobs.enqueue(LINK_SIMILAR_JOB, 'Verknüpfungen für neue Einträge suchen', {}, { maxAttempts: 2, sameAs: (_p, status) => status === 'pending' });
  });

  // large file operations of the agent run as jobs of their own, under the run id (#304)
  const agentFileJobs = new AgentFileJobs(jobs, archive, agentRuns);
  agentFileJobs.register();

  // a check that is still queued or running covers a new request (startup, interval and manual triggers can meet)
  const enqueueLinkRun = (trigger: string) => jobs.enqueue(LINK_RUN_JOB, 'Verknüpfungslauf (rückwirkend)', { trigger }, { maxAttempts: 2, sameAs: () => true });
  const enqueueConsistency = (trigger: string) => jobs.enqueue('consistency.check', 'Archivprüfung', { trigger }, { maxAttempts: 1, sameAs: () => true });
  const agent = new AgentService(
    ctx,
    {
      paths,
      settings,
      docs: documentsSvc,
      search,
      graph,
      privacy,
      decisions,
      openItems,
      reminders,
      events: eventsSvc,
      notes,
      timeline,
      insights,
      actions,
      archive,
      categories,
      scanner,
      jobs,
      audit,
      undo,
      persons,
      notifications,
      openItemDuplicates,
      noteEventDuplicates,
      memory,
      fileJobs: agentFileJobs,
      links,
      capture,
      answers,
      enqueueConsistency,
    },
    llm,
    agentRuns,
    appState,
    memory,
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
  chat.wire({
    actions,
    archive,
    agent,
    createdTogether: (entries, message) => {
      if (settings.get().links.autoPropose)
        notifyLinkProposals(links.linkCreatedTogether(entries, { evidence: `Aus derselben Nachricht: „${message.text}“`, sourceIds: [message.id] }));
    },
  });
  // a new or edited note is analysed like a document, in a job of its own (#273)
  const enqueueNoteAnalysis = (entry: { id: string; type: string }) => {
    if (entry.type !== 'note' || !settings.get().links.autoPropose) return;
    jobs.enqueue(
      NOTE_ANALYZE_JOB,
      'Notiz analysieren',
      { noteId: entry.id },
      { maxAttempts: 2, sameAs: (p, status) => status === 'pending' && p.noteId === entry.id },
    );
  };
  events.on('entry:created', enqueueNoteAnalysis);
  events.on('entry:updated', enqueueNoteAnalysis);
  // entries extracted from the same document belong together (#272)
  events.on('entry:created', (entry: { id: string }) => {
    if (!settings.get().links.autoPropose) return;
    try {
      notifyLinkProposals(links.linkSameDocument(entry.id));
    } catch (err) {
      logger.warn('links', 'Linking entries of one document failed', { error: err, id: entry.id });
    }
  });
  capture.wire({ actions });
  actions.setAgentBatchExecutor((params) => agent.executeBatch(params));
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
      // every waiting file (oldest first), in batches like a manual analysis
      const ids = scanner.filesAwaitingAnalysis();
      for (let i = 0; i < ids.length; i += AUTO_ANALYZE_BATCH) {
        const batch = ids.slice(i, i + AUTO_ANALYZE_BATCH);
        jobs.enqueue('scanner.analyze', `Analysiere ${batch.length} neue Dateien`, { fileIds: batch, confirmLlm: false });
      }
    }
    return summaries;
  });
  jobs.register<{ fileIds: string[]; confirmLlm: boolean }>('scanner.analyze', async (job) => {
    const res = await scanner.analyzeFiles(job.payload.fileIds, job.payload.confirmLlm, job);
    agent.scheduleInbox();
    return res;
  });
  // background runs of the agent (#313): one job per trigger, cancellable, resumed after a restart
  jobs.register<{ kind: BackgroundKind; docIds?: string[] }>('agent.background', async (job) => {
    const run = await agent.runBackground(job.payload.kind, { docIds: job.payload.docIds, signal: job.signal, report: (p, m) => job.report(p, m) });
    return { summary: run ? `${run.status}: ${run.steps.length} Schritt(e)` : 'nichts zu tun', runId: run?.id ?? null };
  });
  // the retroactive link run (#279) and topic proposals from groups (#281): local, resumable, ONE notification at the end
  jobs.register<{ trigger?: string }>(LINK_RUN_JOB, async (job) => {
    let processed = 0;
    let proposed = 0;
    for (;;) {
      job.throwIfCancelled();
      const r = await links.backfill({
        maxEntries: 100,
        signal: job.signal,
        onProgress: (done, total) => job.report(null, `${processed + done} Einträge geprüft (dieser Abschnitt: ${done} von ${total})`),
      });
      processed += r.processed;
      proposed += r.proposed;
      if (r.done || !r.processed) break;
    }
    job.throwIfCancelled();
    job.report(null, 'Suche Gruppen ähnlicher Einträge ohne Thema');
    const clusters = await links.clusters({ signal: job.signal });
    for (const c of clusters)
      links.proposeTopic(
        c.name,
        c.members.map((m) => m.id),
      );
    if (proposed || clusters.length)
      notifications.create({
        title: 'Verknüpfungsvorschläge',
        description: [
          proposed ? `${proposed} Verknüpfung${proposed === 1 ? '' : 'en'} vorgeschlagen.` : null,
          clusters.length ? `${clusters.length} neue${clusters.length === 1 ? 's Thema' : ' Themen'} vorgeschlagen.` : null,
          'Du entscheidest, was übernommen wird.',
        ]
          .filter(Boolean)
          .join(' '),
        type: 'assignment_proposal',
        priority: 'low',
        proposedActions: [{ label: 'Hinweise ansehen', kind: 'navigate', target: '/insights/' }],
        dedupeKey: `link-run:${job.id}`,
      });
    return { summary: `${processed} Einträge geprüft, ${proposed} Verknüpfungen und ${clusters.length} Themen vorgeschlagen` };
  });
  jobs.register<{ noteId: string }>(NOTE_ANALYZE_JOB, async (job) => {
    const r = await noteAnalysis.analyze(job.payload.noteId, { signal: job.signal });
    notifyLinkProposals(r?.proposed ?? 0);
    return { summary: r ? `${r.proposed} Verknüpfungen vorgeschlagen, ${r.outdated} veraltet` : 'Notiz nicht (mehr) vorhanden' };
  });
  jobs.register(LINK_SIMILAR_JOB, async (job) => {
    const r = await links.runPendingSimilar({ max: settings.get().links.maxProposalsPerEntry, signal: job.signal });
    notifyLinkProposals(r.proposed);
    job.throwIfCancelled();
    return { summary: `${r.processed} Einträge geprüft, ${r.proposed} Verknüpfungen vorgeschlagen` };
  });
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
    reader,
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
    noteAnalysis,
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
    capture,
    answers,
    agent,
    agentRuns,
    agentFileJobs,
    links,
    enqueueLinkRun,
    memory,
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
      // the retroactive link run starts once after the update that brought it (#279); later only on request or by the agent
      if (!appState.get('links.run.initial')) {
        appState.set('links.run.initial', new Date().toISOString());
        enqueueLinkRun('update');
      }
      const BG_LABEL: Record<string, string> = { inbox: 'Eingang sortieren', archive_check: 'Agentische Archivprüfung', links: 'Verknüpfungen pflegen' };
      agent.start({
        enqueue: (kind, docIds) => jobs.enqueue('agent.background', `Hintergrund-Agent: ${BG_LABEL[kind] ?? 'Ablauf'}`, { kind, docIds }, { maxAttempts: 2 }),
        post: (title, content, existing) => chat.postAssistant(title, content, existing),
      });
      if (settings.get().backups.autoOnStartup)
        void backup.create(settings.get().backups.includeArchive, 'startup').catch((err) => logger.warn('backup', 'Automatic backup failed', { error: err }));
    },

    /**
     * Stops background work and closes the database. Running jobs are interrupted and resume after the next start;
     * waits at most `jobTimeoutMs` for them (default 5 s), so quitting never hangs on a long scan or OCR.
     */
    async shutdown(opts: { jobTimeoutMs?: number } = {}): Promise<void> {
      reminders.stop();
      agent.stop();
      scanner.stop();
      consistency.stopTimer();
      await jobs.interrupt(opts.jobTimeoutMs);
      await pool.close();
      await reader.close();
      database.close();
      await logger.close();
    },
  };
}
