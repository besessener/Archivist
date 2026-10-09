import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService, type MigrationStatus } from '../db/database';
import { EventBus, ensureDataDirs, resolveDataPaths, type AppContext } from '../context';
import { AppStateService } from '../services/app-state';
import { AuditService } from '../services/audit';
import { applyPendingRestore } from '../services/backup-restore';
import { migrateLegacyLayout, traceLayoutStep } from '../services/data-layout-migration';
import { CategoryService } from '../services/categories';
import { EmbeddingService } from '../services/embedding';
import { JobQueueService } from '../services/jobs';
import { KnowledgeGraphService } from '../services/knowledge-graph';
import { LlmService, type FetchLike } from '../services/llm';
import { NotificationService } from '../services/notifications';
import { PersonService } from '../services/persons';
import { PrivacyService } from '../services/privacy';
import { ReminderService } from '../services/reminders';
import { SearchService } from '../services/search';
import { SecretService, type SecretCipher } from '../services/secret';
import { SelfService } from '../services/self';
import { SettingsService, settingsLoadNotification } from '../services/settings';
import { SpeechService, type SpeechModel } from '../services/speech';
import { SPEECH_IDLE_MS, SPEECH_TIMEOUT_MS, WorkerSpeechEngine, type SpeechEngine } from '../services/speech/engine';
import { SPEECH_MODELS, type SpeechModelSpec } from '../services/speech/model-manifest';
import { SpeechModelStore } from '../services/speech/model-store';
import { UndoService } from '../services/undo';
import type { SpeechModelName } from '@archivist/shared';
import { Logger } from '../util/logger';
import { maskingOf } from '../util/redact';
import { DbReader } from '../workers/db-reader';
import { WorkerPool } from '../workers/pool';

export type BaseServices = ReturnType<typeof createBaseServices>;

export interface CreateServicesOptions {
  /** Root of the document store: archive, inbox, quarantine, trash (default: ~/Documents/Archivist) */
  dataRoot: string;
  /** Folder of database, index, config, logs and backups (default: the per-user data folder); omitted = below `dataRoot`. */
  appDataRoot?: string;
  /** Folder with the Drizzle migrations */
  migrationsFolder: string;
  cipher: SecretCipher;
  /** Version of the app, shown by the agent's diagnosis. */
  appVersion?: string;
  /** Path to the bundled worker script; null/undefined = tasks run inline (tests) */
  workerFile?: string | null;
  /** Path to the bundled read worker (own read-only DB connection); null/undefined = queries run inline (tests) */
  readerFile?: string | null;
  /** Speech input: the bundled Whisper worker; without it (and without `speech.engine`) nothing can be transcribed. */
  speechWorkerFile?: string | null;
  /** Replaces the model, its download and the engine (tests). */
  speech?: { models?: Partial<Record<SpeechModelName, SpeechModelSpec>>; engine?: SpeechEngine; fetchImpl?: FetchLike };
  fetchImpl?: FetchLike;
  jobConcurrency?: number;
  /** Wait before the first job retry; doubles with every further attempt (default 5 s, tests: 0) */
  jobRetryDelayMs?: number;
  /** Delay between LLM retries (tests: 0) */
  llmRetryDelayMs?: number;
}

/** Directory structure, settings, logging, database and the services every domain service builds on. */
export function createBaseServices(options: CreateServicesOptions) {
  const layout = options.appDataRoot
    ? migrateLegacyLayout({ legacyRoot: options.dataRoot, appDataRoot: options.appDataRoot, onProgress: traceLayoutStep(options.appDataRoot) })
    : { migrated: false as const };
  const baseline = resolveDataPaths({ root: options.dataRoot, appDataRoot: options.appDataRoot });
  ensureDataDirs(baseline);
  const events = new EventBus();
  const settings = new SettingsService({ file: path.join(baseline.config, 'settings.json'), defaultArchiveRoot: baseline.archive, events });
  const paths = resolveDataPaths({ root: options.dataRoot, appDataRoot: options.appDataRoot, archiveOverride: settings.get().archiveRoot });
  fs.mkdirSync(paths.archive, { recursive: true });

  const logger = new Logger(paths.logs, settings.get().logs.level);
  if (layout.migrated) logger.info('app', 'Application data moved to the per-user data folder', { from: layout.from, to: layout.to, entries: layout.entries });
  logger.setMasking(maskingOf(settings.get()));
  const restore = applyPendingRestore(paths, paths.archive);
  if (restore) logger.info('backup', 'Database restored from a backup', { ...restore });
  const database = new DatabaseService(path.join(paths.database, 'archivist.db'), logger);
  const migration: MigrationStatus = database.migrate(options.migrationsFolder, paths.backups);
  logger.info('app', 'Database ready', { migrations: migration });
  const ctx: AppContext = { paths, database, logger, events };

  const secrets = new SecretService({ file: path.join(paths.config, 'llm-api-key.enc'), cipher: options.cipher, logger });
  const appState = new AppStateService(ctx);
  const audit = new AuditService(ctx, appState);
  audit.seedAnchor();
  // the request was logged in the database that is now set aside: the restored one records that it took over
  if (restore) audit.log({ action: 'backup.restore', actor: 'user', trigger: 'startup', confirmed: true, after: { ...restore } });
  const undo = new UndoService(ctx, audit);
  const pool = new WorkerPool(options.workerFile ?? null);
  // own worker, so a slow file never delays a search
  const searchPool = new WorkerPool(options.workerFile ?? null, 1);
  const reader = new DbReader(database.db, { workerFile: options.readerFile ?? null, databaseFile: database.file, logger });
  const llm = new LlmService({ ctx, settings, secrets, fetchImpl: options.fetchImpl, retryDelayMs: options.llmRetryDelayMs });
  const privacy = new PrivacyService(settings);
  const speech = createSpeech({ ctx, privacy, settings, options });
  const embedding = new EmbeddingService({ settings, llm, logger: ctx.logger });
  const graph = new KnowledgeGraphService({ ctx, audit, undo });
  const persons = new PersonService(ctx, graph);
  const self = new SelfService({ ctx, settings, graph });
  persons.setSelfResolver(self.resolver);
  // Search queries go to the embedding endpoint only in mode „automatisch“ – „vorher fragen“ uses local vectors only.
  const search = new SearchService({ ctx, embedding, pool: searchPool, remoteAllowed: () => privacy.mode() === 'auto' && llm.isConfigured() });
  const categories = new CategoryService(ctx);
  const jobs = new JobQueueService(ctx, { concurrency: options.jobConcurrency ?? 2, retryBaseDelayMs: options.jobRetryDelayMs });
  const notifications = new NotificationService(ctx);
  const reminders = new ReminderService({ ctx, notifications, settings });
  // Settings are loaded before the database exists; report a repaired or unreadable settings.json now.
  const settingsProblem = settings.takeLoadProblem();
  if (settingsProblem) {
    logger.warn('settings', 'settings.json was invalid and has been repaired', { ...settingsProblem });
    notifications.create(settingsLoadNotification(settingsProblem));
  }

  return {
    paths,
    ctx,
    events,
    logger,
    migration,
    settings,
    secrets,
    database,
    appState,
    audit,
    undo,
    pool,
    searchPool,
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
    speech,
  };
}

/** The Whisper models live in the index folder; the worker starts on the first recording. */
function createSpeech({
  ctx,
  privacy,
  settings,
  options,
}: {
  ctx: AppContext;
  privacy: PrivacyService;
  settings: SettingsService;
  options: CreateServicesOptions;
}): SpeechService {
  const modelsDir = path.join(ctx.paths.index, 'models');
  const fetchImpl = options.speech?.fetchImpl ?? fetch;
  const modelOf = (name: SpeechModelName): SpeechModel => {
    const spec = options.speech?.models?.[name] ?? SPEECH_MODELS[name];
    return { spec, store: new SpeechModelStore(spec, modelsDir, fetchImpl) };
  };
  const models = { small: modelOf('small'), medium: modelOf('medium'), turbo: modelOf('turbo') };
  const engine =
    options.speech?.engine ??
    new WorkerSpeechEngine({ workerFile: options.speechWorkerFile ?? null, modelsDir, idleMs: SPEECH_IDLE_MS, timeoutMs: SPEECH_TIMEOUT_MS });
  return new SpeechService({ ctx, privacy, settings, models, engine });
}
