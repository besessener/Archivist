import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService, type MigrationStatus } from '../db/database';
import { EventBus, ensureDataDirs, resolveDataPaths, type AppContext } from '../context';
import { AuditService } from '../services/audit';
import { CategoryService } from '../services/categories';
import { EmbeddingService } from '../services/embedding';
import { JobQueueService } from '../services/jobs';
import { KnowledgeGraphService } from '../services/knowledge-graph';
import { LlmService } from '../services/llm';
import { NotificationService } from '../services/notifications';
import { PersonService } from '../services/persons';
import { PrivacyService } from '../services/privacy';
import { ReminderService } from '../services/reminders';
import { SearchService } from '../services/search';
import { SecretService } from '../services/secret';
import { SelfService } from '../services/self';
import { SettingsService, settingsLoadNotification } from '../services/settings';
import { UndoService } from '../services/undo';
import { Logger } from '../util/logger';
import { DbReader } from '../workers/db-reader';
import { WorkerPool } from '../workers/pool';
import type { CreateServicesOptions } from '../create-services';

export type BaseServices = ReturnType<typeof createBaseServices>;

/** Directory structure, settings, logging, database and the services every domain service builds on. */
export function createBaseServices(opts: CreateServicesOptions) {
  const baseline = resolveDataPaths(opts.dataRoot);
  ensureDataDirs(baseline);
  const events = new EventBus();
  const settings = new SettingsService(path.join(baseline.config, 'settings.json'), baseline.archive, events);
  const paths = resolveDataPaths(opts.dataRoot, settings.get().archiveRoot);
  fs.mkdirSync(paths.archive, { recursive: true });

  const logger = new Logger(paths.logs, settings.get().logs.level);
  const database = new DatabaseService(path.join(paths.database, 'archivist.db'), logger);
  const migration: MigrationStatus = database.migrate(opts.migrationsFolder);
  logger.info('app', 'Database ready', { migrations: migration });
  const ctx: AppContext = { paths, database, logger, events };

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
  };
}
