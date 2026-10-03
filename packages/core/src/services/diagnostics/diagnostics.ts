import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { count, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { auditLog, chunks, decisions, documents, entities, events, jobs, llmTransmissions, openItems, relations, reminders } from '../../db/schema';
import { toErrorInfo } from '../../util/errors';
import type { LlmService } from '../llm';
import type { SettingsService } from '../settings';
import { directorySize } from './directory-size';
import type { ExcludedLocations } from './excluded-locations';

/** The only text the endpoint check sends: no document content, no document ids. */
export const ENDPOINT_PROBE_TEXT = 'Verbindungstest';
export const ENDPOINT_PROBE_PURPOSE = 'Diagnose: Embedding-Endpunkt';

const MAIN_TABLES: Array<[label: string, table: SQLiteTable]> = [
  ['Dokumente', documents],
  ['Textabschnitte', chunks],
  ['Einträge im Wissensgraph', entities],
  ['Verknüpfungen', relations],
  ['Entscheidungen', decisions],
  ['Offene Punkte', openItems],
  ['Ereignisse', events],
  ['Erinnerungen', reminders],
  ['Aufträge', jobs],
  ['Änderungsprotokoll', auditLog],
  ['Übertragungsprotokoll', llmTransmissions],
];
const FAILED_JOB_LIMIT = 5;
const MODE_LABEL = { auto: 'automatisch', confirm: 'vorher fragen', local_only: 'nur lokal' } as const;

export type EndpointCheck = { state: 'skipped'; reason: string } | { state: 'ok'; ms: number } | { state: 'failed'; ms: number; message: string };

export interface FailedJob {
  type: string;
  attempts: number;
  finishedAt: string | null;
  /** Label and error; null when they name something excluded from the LLM. */
  detail: { label: string; error: string } | null;
}

export interface DiagnosticsReport {
  environment: { appVersion: string; electron: string | null; node: string; platform: string };
  storage: { dataDirectoryBytes: number; dataDirectoryComplete: boolean; freeDiskBytes: number | null; databaseBytes: number };
  tableRows: Array<{ label: string; rows: number }>;
  models: { llm: string; llmHost: string; embedding: string; chunksByModel: Array<{ model: string | null; chunks: number }> };
  privacyMode: 'auto' | 'confirm' | 'local_only';
  endpoint: EndpointCheck;
  failedJobs: FailedJob[];
}

export type DiagnosticsDeps = { ctx: AppContext; settings: SettingsService; llm: LlmService; excluded: ExcludedLocations; appVersion: string };

/** Facts about this installation for the agent's diagnosis; the only outgoing request is the fixed embedding probe. */
export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async collect(): Promise<DiagnosticsReport> {
    const llmSettings = this.deps.settings.get().llm;
    return {
      environment: { appVersion: this.deps.appVersion, electron: process.versions.electron ?? null, node: process.versions.node, platform: process.platform },
      storage: await this.storage(),
      tableRows: MAIN_TABLES.map(([label, table]) => ({ label, rows: this.db.select({ rows: count() }).from(table).get()?.rows ?? 0 })),
      models: {
        llm: llmSettings.model,
        llmHost: hostOf(llmSettings.baseUrl),
        embedding: llmSettings.embeddingModel,
        chunksByModel: this.db
          .select({ model: chunks.embeddingModel, chunks: count() })
          .from(chunks)
          .groupBy(chunks.embeddingModel)
          .orderBy(desc(count()))
          .all(),
      },
      privacyMode: this.deps.settings.get().privacy.llmMode,
      endpoint: await this.checkEndpoint(),
      failedJobs: this.failedJobs(),
    };
  }

  private async storage(): Promise<DiagnosticsReport['storage']> {
    const { paths, database } = this.deps.ctx;
    const size = await directorySize(paths.root);
    const stats = await fsp.statfs(paths.root).catch(() => null);
    return {
      dataDirectoryBytes: size.bytes,
      dataDirectoryComplete: size.complete,
      freeDiskBytes: stats ? stats.bavail * stats.bsize : null,
      databaseBytes: [database.file, `${database.file}-wal`].reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0),
    };
  }

  /** Mirrors the search: the endpoint is only asked unprompted in mode „automatisch“ (never „vorher fragen“ or „nur lokal“). */
  private async checkEndpoint(): Promise<EndpointCheck> {
    const { llm, settings } = this.deps;
    if (!llm.isConfigured()) return { state: 'skipped', reason: 'Das LLM ist nicht konfiguriert.' };
    if (!llm.canUseInBackground())
      return { state: 'skipped', reason: `Der Datenschutzmodus „${MODE_LABEL[settings.get().privacy.llmMode]}“ erlaubt keine ungefragte Anfrage.` };
    if (!settings.get().llm.embeddingModel) return { state: 'skipped', reason: 'Es ist kein Embedding-Modell eingestellt.' };
    const started = Date.now();
    try {
      await llm.embeddings([ENDPOINT_PROBE_TEXT], { purpose: ENDPOINT_PROBE_PURPOSE });
      return { state: 'ok', ms: Date.now() - started };
    } catch (error) {
      return { state: 'failed', ms: Date.now() - started, message: this.deps.ctx.logger.sanitizeString(toErrorInfo(error).message, 200) };
    }
  }

  private failedJobs(): FailedJob[] {
    const isExcluded = this.deps.excluded.current();
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'failed'))
      .orderBy(desc(jobs.finishedAt))
      .limit(FAILED_JOB_LIMIT)
      .all()
      .map((job) => {
        const detail = { label: this.deps.ctx.logger.sanitizeString(job.label, 120), error: this.deps.ctx.logger.sanitizeString(job.error ?? '', 300) };
        return { type: job.type, attempts: job.attempts, finishedAt: job.finishedAt, detail: isExcluded(`${job.label} ${job.error ?? ''}`) ? null : detail };
      });
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'ungültige Adresse';
  }
}
