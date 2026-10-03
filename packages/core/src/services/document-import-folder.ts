import fsp from 'node:fs/promises';
import path from 'node:path';
import { permissionError } from '../util/errors';
import { DOCUMENT_ANALYZE_BATCH_JOB, type AnalyzeBatchPayload } from './document-batch';
import { folderRefusal, importWalkRules } from './document-import-guard';
import type { DocumentDeps } from './document-model';
import type { JobContext } from './jobs';
import { SCAN_MAX_FILES } from '../workers/tasks';

/** Job type that copies the supported files of a dropped folder (and its subfolders) into the inbox (#228). */
export const DOCUMENT_IMPORT_FOLDER_JOB = 'documents.importFolder';

/** Files one folder import takes; more are left out with a clear message (the walk is the same as the scanner's). */
export const IMPORT_FOLDER_MAX_FILES = SCAN_MAX_FILES;
const COPY_CHUNK = 50;
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

/** The part of the importer a folder import uses (typed by shape to keep the modules acyclic). */
export interface QuietImporter {
  importQuietly(files: string[], opts: { allowLlm: boolean }): Promise<{ imported: Array<{ id: string }>; duplicates: unknown[]; rejected: unknown[] }>;
}

export interface ImportFolderPayload {
  path: string;
  allowLlm: boolean;
}

interface FolderCheckpoint {
  copied: number;
  imported: number;
  duplicates: number;
  rejected: number;
  /** The documents this run created – only these are analysed afterwards. */
  importedIds: string[];
}

/** Recursive import of a folder: originals stay untouched, only copies enter the inbox; the analysis of exactly these copies is its own job. */
export class FolderImport {
  /** Upper bound of files per folder (lowered in tests). */
  maxFiles = IMPORT_FOLDER_MAX_FILES;

  constructor(
    private readonly deps: DocumentDeps,
    private readonly importer: QuietImporter,
  ) {}

  async run(job: JobContext<ImportFolderPayload>): Promise<{ summary: string }> {
    const refusal = folderRefusal(job.payload.path, this.deps);
    if (refusal) throw permissionError(refusal, job.payload.path);
    const saved = job.checkpoint as Partial<FolderCheckpoint> | null;
    const progress: FolderCheckpoint = { copied: 0, imported: 0, duplicates: 0, rejected: 0, importedIds: [], ...saved };
    const walked = await this.deps.pool.run('scanDirectory', {
      root: await fsp.realpath(job.payload.path),
      recursive: true,
      ...importWalkRules(this.deps),
      maxSizeBytes: MAX_IMPORT_BYTES,
      maxFiles: this.maxFiles,
    });
    const files = walked.entries.map((entry) => entry.path);
    await this.copyFiles(files, { job, progress });
    return { summary: this.queueAnalysis({ job, progress, limitReached: walked.limitReached }) };
  }

  private async copyFiles(files: string[], run: { job: JobContext<ImportFolderPayload>; progress: FolderCheckpoint }): Promise<void> {
    const { job, progress } = run;
    for (; progress.copied < files.length; progress.copied += COPY_CHUNK) {
      job.throwIfCancelled();
      const chunk = files.slice(progress.copied, progress.copied + COPY_CHUNK);
      const result = await this.importer.importQuietly(chunk, { allowLlm: job.payload.allowLlm });
      progress.imported += result.imported.length;
      progress.importedIds.push(...result.imported.map((doc) => doc.id));
      progress.duplicates += result.duplicates.length;
      progress.rejected += result.rejected.length;
      job.saveCheckpoint({ ...progress, copied: progress.copied + chunk.length });
      job.report(null, `${Math.min(progress.copied + COPY_CHUNK, files.length)} von ${files.length} Dateien kopiert`);
    }
    progress.copied = files.length;
  }

  /** Hands the copies of this run (and only these) to one analysis job that reports once; a resumed run does not queue a second one. */
  private queueAnalysis(run: { job: JobContext<ImportFolderPayload>; progress: FolderCheckpoint; limitReached: boolean }): string {
    const { job, progress } = run;
    const folder = job.payload.path;
    const cap = run.limitReached
      ? ` Der Ordner enthält mehr als ${this.maxFiles.toLocaleString('de-DE')} unterstützte Dateien; nur die ersten ${this.maxFiles.toLocaleString('de-DE')} wurden übernommen. Importiere die übrigen Unterordner einzeln.`
      : '';
    const payload: AnalyzeBatchPayload = {
      documentIds: progress.importedIds,
      allowLlm: job.payload.allowLlm,
      duplicates: progress.duplicates,
      rejected: progress.rejected,
      title: `Ordner „${path.basename(folder)}“ importiert`,
      note: cap,
      offerLlm: true,
      sourceJobId: job.id,
    };
    this.deps.jobs.enqueue(DOCUMENT_ANALYZE_BATCH_JOB, {
      label: `Analysiere ${progress.importedIds.length} Dokumente aus „${path.basename(folder)}“`,
      payload,
      maxAttempts: 1,
      sameAs: (active: AnalyzeBatchPayload) => active.sourceJobId === job.id,
    });
    return `${progress.imported} Dokumente übernommen, ${progress.duplicates} Duplikate, ${progress.rejected} nicht importierbar; die Analyse läuft als eigener Auftrag.${cap}`;
  }
}
