import fsp from 'node:fs/promises';
import path from 'node:path';
import { SUPPORTED_EXTENSIONS } from '@archivist/shared';
import { and, asc, eq, gt, gte, notInArray, sql } from 'drizzle-orm';
import { documents } from '../db/schema';
import { SCAN_MAX_FILES } from '../workers/tasks';
import { emptyBatchState, BATCH_SIZE, type BatchState, type DocumentBatchAnalysis, type DocumentSource } from './document-batch';
import type { DocumentImporter } from './document-import';
import type { DocumentDeps } from './document-model';
import type { JobContext } from './jobs';

/** Job type that copies the supported files of a dropped folder (and its subfolders) into the inbox (#228). */
export const DOCUMENT_IMPORT_FOLDER_JOB = 'documents.importFolder';

/** Files one folder import takes; more are left out with a clear message (the walk is the same as the scanner's). */
export const IMPORT_FOLDER_MAX_FILES = SCAN_MAX_FILES;
const COPY_CHUNK = 50;
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

export interface ImportFolderPayload {
  path: string;
  allowLlm: boolean;
}

interface FolderCheckpoint {
  startedAt: string;
  copied: number;
  imported: number;
  duplicates: number;
  rejected: number;
  analysis: BatchState | null;
}

/** Recursive import of a folder: originals stay untouched, only copies enter the inbox; one job, one notification. */
export class FolderImport {
  /** Upper bound of files per folder (lowered in tests). */
  maxFiles = IMPORT_FOLDER_MAX_FILES;

  constructor(
    private readonly deps: DocumentDeps,
    private readonly importer: DocumentImporter,
    private readonly analysis: DocumentBatchAnalysis,
  ) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async run(job: JobContext<ImportFolderPayload>): Promise<{ summary: string }> {
    const saved = job.checkpoint as Partial<FolderCheckpoint> | null;
    const progress: FolderCheckpoint = { startedAt: new Date().toISOString(), copied: 0, imported: 0, duplicates: 0, rejected: 0, analysis: null, ...saved };
    const walked = await this.deps.pool.run('scanDirectory', {
      root: await fsp.realpath(job.payload.path),
      recursive: true,
      excludedDirs: [],
      excludedFiles: [],
      extensions: [...SUPPORTED_EXTENSIONS],
      maxSizeBytes: MAX_IMPORT_BYTES,
      maxFiles: this.maxFiles,
    });
    const files = walked.entries.map((entry) => entry.path);
    await this.copyFiles(files, { job, progress });
    const state = await this.analyzeCopies({ job, progress });
    return { summary: this.report({ folder: job.payload.path, limitReached: walked.limitReached, progress, state }) };
  }

  private async copyFiles(files: string[], run: { job: JobContext<ImportFolderPayload>; progress: FolderCheckpoint }): Promise<void> {
    const { job, progress } = run;
    for (; progress.copied < files.length; progress.copied += COPY_CHUNK) {
      job.throwIfCancelled();
      const chunk = files.slice(progress.copied, progress.copied + COPY_CHUNK);
      const result = await this.importer.importQuietly(chunk, { allowLlm: job.payload.allowLlm });
      progress.imported += result.imported.length;
      progress.duplicates += result.duplicates.length;
      progress.rejected += result.rejected.length;
      job.saveCheckpoint({ ...progress, copied: progress.copied + chunk.length });
      job.report(null, `${Math.min(progress.copied + COPY_CHUNK, files.length)} von ${files.length} Dateien kopiert`);
    }
    progress.copied = files.length;
  }

  /** The copies of this run that are still unanalysed – found in the database, so a resumed run continues where it stopped. */
  private source(progress: FolderCheckpoint): DocumentSource {
    const waiting = and(eq(documents.status, 'staged'), gte(documents.createdAt, progress.startedAt));
    const total =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(documents)
        .where(waiting)
        .get()?.n ?? 0;
    const covered = new Set(this.deps.jobs.activePayloads<{ documentId?: string }>('document.analyze').map((p) => p.documentId));
    return {
      total: total + (progress.analysis ? progress.analysis.analyzed + progress.analysis.failed + progress.analysis.skipped : 0),
      next: (after) =>
        this.db
          .select({ id: documents.id })
          .from(documents)
          .where(and(waiting, after ? gt(documents.id, after) : undefined, covered.size ? notInArray(documents.id, [...covered] as string[]) : undefined))
          .orderBy(asc(documents.id))
          .limit(BATCH_SIZE)
          .all()
          .map((row) => row.id),
    };
  }

  private analyzeCopies(run: { job: JobContext<ImportFolderPayload>; progress: FolderCheckpoint }): Promise<BatchState> {
    const { job, progress } = run;
    const state = progress.analysis ?? emptyBatchState();
    return this.analysis.run(this.source(progress), {
      allowLlm: job.payload.allowLlm,
      job,
      state,
      onProgress: (analysis) => job.saveCheckpoint({ ...progress, analysis }),
    });
  }

  private report(result: { folder: string; limitReached: boolean; progress: FolderCheckpoint; state: BatchState }): string {
    const { progress, state } = result;
    const cap = result.limitReached
      ? ` Der Ordner enthält mehr als ${this.maxFiles.toLocaleString('de-DE')} unterstützte Dateien; nur die ersten ${this.maxFiles.toLocaleString('de-DE')} wurden übernommen. Importiere die übrigen Unterordner einzeln.`
      : '';
    const text = this.analysis.announce({
      title: `Ordner „${path.basename(result.folder)}“ importiert`,
      state,
      skippedBefore: { duplicates: progress.duplicates, rejected: progress.rejected },
      note: cap,
    });
    return `${text}${cap}`;
  }
}
