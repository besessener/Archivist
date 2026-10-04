import fsp from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { documents, scanFiles, scanRoots } from '../../db/schema';
import { permissionError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { isInside } from '../../util/paths';
import { isTokenCapError } from '../../util/token-cap';
import type { WorkerPool } from '../../workers/pool';
import type { DocRow, DocumentService } from '../documents';
import { progressLine, runSummary } from '../../util/bulk-text';
import { untilSettled } from '../analysis-retry';
import { isJobCancelled, type JobContext, type JobQueueService } from '../jobs';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NotificationService } from '../notifications';
import type { PrivacyService } from '../privacy';
import { pausingOnTokenCap } from '../token-cap-pause';
import { duplicateOf, type FileRow, type RootRow } from './scan-files';

/** Document states in which a changed source file updates the existing inbox entry instead of creating a second one. */
const INBOX_DOC_STATUSES = ['staged', 'proposed', 'failed'];

export interface FileAnalysisDeps {
  ctx: AppContext;
  pool: WorkerPool;
  docs: DocumentService;
  graph: KnowledgeGraphService;
  privacy: PrivacyService;
  notifications: NotificationService;
  jobs: JobQueueService;
}

/** Progress of a `scanner.analyze` job: how many of its files are handled; the rest is read back from the scan files. */
interface AnalyzeCheckpoint {
  next: number;
  failed: number;
  failures: string[];
}

const MAX_REPORTED_FAILURES = 3;

function analyzeCheckpoint(raw: unknown): AnalyzeCheckpoint {
  const stored = raw && typeof raw === 'object' ? (raw as Partial<AnalyzeCheckpoint>) : {};
  return { next: stored.next ?? 0, failed: stored.failed ?? 0, failures: stored.failures ?? [] };
}

export interface AnalysisOptions {
  mode: ReturnType<PrivacyService['mode']>;
  confirmLlm: boolean;
  job?: JobContext;
  progress?: number;
  /** Several files at once: the run reports once at its end instead of once per file. */
  quiet: boolean;
  /** Analyse files again that are already `analyzed` (the user chose „erneut analysieren“). */
  reanalyze?: boolean;
}

export type FileResult = { kind: 'analyzed'; documentId: string } | { kind: 'skipped' } | { kind: 'failed'; message: string };
const SKIPPED: FileResult = { kind: 'skipped' };

/** The file's current content, read through its real path. */
interface FileContent {
  realPath: string;
  sha: string;
  size: number;
  mtimeMs: number;
}

/** Content analysis of scanned files: the only scan step where content can go to the LLM (with confirmation or in „auto“). */
export class FileAnalysis {
  constructor(private readonly deps: FileAnalysisDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Analyzes the files; a re-run after a crash or quit continues after the files already handled (and paid for). */
  async analyzeFiles(
    fileIds: string[],
    options: { confirmLlm: boolean; reanalyze?: boolean; job?: JobContext },
  ): Promise<{ analyzed: string[]; skipped: string[]; failed: number }> {
    const { confirmLlm, job, reanalyze } = options;
    const checkpoint = analyzeCheckpoint(job?.checkpoint);
    const quiet = fileIds.length > 1;
    const started = Date.now();
    const resumedAt = checkpoint.next;
    const mode = this.deps.privacy.mode();
    const loop = async () => {
      for (; checkpoint.next < fileIds.length; checkpoint.next += 1) {
        job?.throwIfCancelled();
        const result = await this.analyzeOne(fileIds[checkpoint.next]!, {
          mode,
          confirmLlm,
          job,
          quiet,
          reanalyze,
          progress: checkpoint.next / fileIds.length,
        });
        if (result.kind === 'failed') {
          checkpoint.failed += 1;
          if (checkpoint.failures.length < MAX_REPORTED_FAILURES) checkpoint.failures.push(result.message);
        }
        job?.saveCheckpoint({ ...checkpoint, next: checkpoint.next + 1 } satisfies AnalyzeCheckpoint);
        if (quiet)
          job?.report(
            (checkpoint.next + 1) / fileIds.length,
            progressLine({ done: checkpoint.next + 1, total: fileIds.length, elapsedMs: Date.now() - started, sampled: checkpoint.next + 1 - resumedAt }),
          );
      }
    };
    if (job)
      await pausingOnTokenCap(loop, {
        notifications: this.deps.notifications,
        jobId: job.id,
        title: 'Analyse pausiert',
        progress: () => ({ done: checkpoint.next, total: fileIds.length }),
      });
    else await loop();
    const handled = this.handledFiles(fileIds);
    if (quiet) this.announce({ analyzed: handled.analyzed.length, failed: checkpoint.failed, failures: checkpoint.failures });
    return { ...handled, failed: checkpoint.failed };
  }

  /** What became of the files: analysed ones have a document and the status `analyzed`, all others were skipped. */
  private handledFiles(fileIds: string[]): { analyzed: string[]; skipped: string[] } {
    const rows = this.db
      .select({ id: scanFiles.id, status: scanFiles.status, documentId: scanFiles.documentId })
      .from(scanFiles)
      .where(inArray(scanFiles.id, fileIds))
      .all();
    const documentOf = new Map(rows.filter((row) => row.status === 'analyzed' && row.documentId).map((row) => [row.id, row.documentId!]));
    return { analyzed: fileIds.flatMap((id) => documentOf.get(id) ?? []), skipped: fileIds.filter((id) => !documentOf.has(id)) };
  }

  /** The one notification of a run over several files. */
  announce(result: { analyzed: number; failed: number; failures: string[] }): void {
    const reasons = result.failures.length ? ` Grund: ${result.failures.join(' / ')}` : '';
    this.deps.notifications.create({
      title: 'Analyse abgeschlossen',
      description: `${runSummary({ done: result.analyzed, failed: result.failed })}.${reasons}`,
      type: 'scan_done',
      priority: result.failed > 0 ? 'normal' : 'low',
      proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
    });
  }

  /** One file; a failure is reported (or, in a run over several files, returned for the run's one notification). */
  async analyzeOne(id: string, options: AnalysisOptions): Promise<FileResult> {
    const file = this.db.select().from(scanFiles).where(eq(scanFiles.id, id)).get();
    if (!file || file.status === 'excluded') return SKIPPED;
    if (file.status === 'analyzed' && !options.reanalyze) return SKIPPED;
    if (!options.quiet) options.job?.report(options.progress ?? null, `Analysiere ${file.name}`);
    try {
      return await this.analyzeContent(file, options);
    } catch (err) {
      if (isJobCancelled(err) || isTokenCapError(err)) throw err; // cancelled or paused by the token limit – no per-file failure
      // analyze() has already set the document to `failed` (reprocessable from the inbox), so it is not stuck in `analyzing`
      this.deps.ctx.logger.warn('scanner', 'Analysis failed', { fileId: id, error: err });
      const message = `${file.name}: ${err instanceof Error ? err.message : String(err)}`;
      if (!options.quiet)
        this.deps.notifications.create({
          title: 'Dateianalyse fehlgeschlagen',
          description: message,
          type: 'import_failed',
          priority: 'normal',
          dedupeKey: `analyze-failed:${id}`,
        });
      return { kind: 'failed', message };
    }
  }

  private async readContent(file: FileRow, signal?: AbortSignal): Promise<{ root: RootRow; content: FileContent }> {
    const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, file.rootId)).get();
    if (!root || !isInside(root.path, file.path)) throw permissionError('Datei liegt nicht in einem freigegebenen Verzeichnis.');
    const realPath = await fsp.realpath(file.path);
    if (!isInside(await fsp.realpath(root.path), realPath)) throw permissionError('Symbolischer Link führt aus dem freigegebenen Verzeichnis heraus.');
    const stats = await fsp.stat(realPath);
    // size and mtime unchanged since the scan hashed it: the scan's hash still describes the content
    const unchangedSinceScan = file.sha256 !== null && file.size === stats.size && file.mtimeMs === stats.mtimeMs;
    const sha = unchangedSinceScan ? file.sha256! : await this.deps.pool.run('hashFile', { path: realPath }, { signal });
    return { root, content: { realPath, sha, size: stats.size, mtimeMs: stats.mtimeMs } };
  }

  private async analyzeContent(file: FileRow, options: AnalysisOptions): Promise<FileResult> {
    const { root, content } = await this.readContent(file, options.job?.signal);
    const { realPath, sha, size, mtimeMs } = content;
    const duplicate = duplicateOf(this.deps.docs, { sha256: sha, documentId: file.documentId });
    if (duplicate) {
      this.db
        .update(scanFiles)
        .set({ status: 'duplicate', duplicateOfDocumentId: duplicate, sha256: sha, size, mtimeMs })
        .where(eq(scanFiles.id, file.id))
        .run();
      return SKIPPED;
    }
    const { doc, replaced } = this.documentFor(file, { root, content });
    // a run paused by the token limit continues with this document instead of finding it as a duplicate
    if (file.documentId !== doc.id) this.db.update(scanFiles).set({ documentId: doc.id }).where(eq(scanFiles.id, file.id)).run();
    const decision = this.deps.privacy.evaluate({ path: realPath, ext: file.ext, rootLlmAllowed: root.llmAllowed });
    const allowLlm = decision.allowed && (options.mode === 'auto' || options.confirmLlm);
    const { job } = options;
    const result = await untilSettled(
      (attempt) => this.deps.docs.analyze(doc.id, { allowLlm, signal: job?.signal, llmAttempt: attempt, quiet: options.quiet }),
      { backoffMs: (failed) => this.deps.jobs.backoffMs(failed), signal: job?.signal, onWait: (message) => job?.report(null, message) },
    );
    // the document was archived in the meantime – nothing to propose
    if (result.skipped) return SKIPPED;
    // a proposal only: the user decides whether the new version really replaces the archived one
    if (replaced)
      this.deps.graph.link(
        { sourceId: doc.id, targetId: replaced.id, relationType: 'supersedes' },
        { confidence: 0.9, status: 'proposed', sourceIds: [doc.id] },
      );
    const updated = this.deps.docs.getRow(doc.id);
    this.db
      .update(scanFiles)
      .set({ status: 'analyzed', documentId: doc.id, sha256: sha, size, mtimeMs, llmStatus: result.usedLlm ? 'analyzed' : updated.llmStatus })
      .where(eq(scanFiles.id, file.id))
      .run();
    return { kind: 'analyzed', documentId: doc.id };
  }

  /** The document for the file's content; a new one may replace the archived version of a file changed after archiving. */
  private documentFor(file: FileRow, scope: { root: RootRow; content: FileContent }): { doc: DocRow; replaced: DocRow | null } {
    const { realPath, sha, size } = scope.content;
    const folderLlmAllowed = scope.root.llmAllowed && this.deps.docs.folderLlmAllowedFor(realPath);
    let doc = file.documentId ? this.db.select().from(documents).where(eq(documents.id, file.documentId)).get() : undefined;
    if (doc && doc.sha256 !== sha && !doc.stagedPath && INBOX_DOC_STATUSES.includes(doc.status)) {
      // changed while still in the inbox: update that entry, no second document (the condition skips one archived meanwhile)
      this.db
        .update(documents)
        .set({ sha256: sha, size, sourcePath: realPath, updatedAt: nowIso() })
        .where(and(eq(documents.id, doc.id), inArray(documents.status, INBOX_DOC_STATUSES)))
        .run();
      doc = this.deps.docs.getRow(doc.id);
    }
    const replaced = doc && doc.sha256 !== sha && (doc.status === 'archived' || doc.status === 'indexed_only') ? doc : null;
    if (!doc || doc.sha256 !== sha) {
      const inserted = this.deps.docs.insertDocument({
        originalName: file.name,
        ext: file.ext,
        size,
        sha256: sha,
        sourcePath: realPath,
        stagedPath: null,
        folderLlmAllowed,
      });
      return { doc: this.deps.docs.getRow(inserted.id), replaced };
    }
    if (doc.folderLlmAllowed !== folderLlmAllowed) this.db.update(documents).set({ folderLlmAllowed }).where(eq(documents.id, doc.id)).run();
    return { doc, replaced };
  }
}
