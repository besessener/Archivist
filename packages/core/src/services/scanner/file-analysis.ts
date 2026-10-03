import fsp from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { documents, scanFiles, scanRoots } from '../../db/schema';
import { permissionError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { isInside } from '../../util/paths';
import type { WorkerPool } from '../../workers/pool';
import type { DocRow, DocumentService } from '../documents';
import { isJobCancelled, type JobContext } from '../jobs';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NotificationService } from '../notifications';
import type { PrivacyService } from '../privacy';
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
}

/** Progress of a `scanner.analyze` job: the file ids handled so far and the results collected for them. */
interface AnalyzeCheckpoint {
  done: string[];
  analyzed: string[];
  skipped: string[];
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

function analyzeCheckpoint(raw: unknown): AnalyzeCheckpoint {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { done: stringList(stored.done), analyzed: stringList(stored.analyzed), skipped: stringList(stored.skipped) };
}

interface AnalysisOptions {
  mode: ReturnType<PrivacyService['mode']>;
  confirmLlm: boolean;
  job?: JobContext;
  progress: number;
}

type FileResult = { kind: 'analyzed'; documentId: string } | { kind: 'skipped' };
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
  async analyzeFiles(fileIds: string[], options: { confirmLlm: boolean; job?: JobContext }): Promise<{ analyzed: string[]; skipped: string[] }> {
    const { confirmLlm, job } = options;
    const resumed = analyzeCheckpoint(job?.checkpoint);
    const analyzed: string[] = [...resumed.analyzed];
    const skipped: string[] = [...resumed.skipped];
    const done = new Set(resumed.done);
    const mode = this.deps.privacy.mode();
    for (const [index, id] of fileIds.entries()) {
      job?.throwIfCancelled();
      if (done.has(id)) continue;
      const result = await this.analyzeFile(id, { mode, confirmLlm, job, progress: index / fileIds.length });
      if (result.kind === 'analyzed') analyzed.push(result.documentId);
      else skipped.push(id);
      done.add(id);
      job?.saveCheckpoint({ done: [...done], analyzed, skipped } satisfies AnalyzeCheckpoint);
    }
    return { analyzed, skipped };
  }

  private async analyzeFile(id: string, options: AnalysisOptions): Promise<FileResult> {
    const file = this.db.select().from(scanFiles).where(eq(scanFiles.id, id)).get();
    if (!file || file.status === 'excluded') return SKIPPED;
    options.job?.report(options.progress, `Analysiere ${file.name}`);
    try {
      return await this.analyzeContent(file, options);
    } catch (err) {
      if (isJobCancelled(err)) throw err; // the whole job was cancelled – no per-file failure
      // analyze() has already set the document to `failed` (reprocessable from the inbox), so it is not stuck in `analyzing`
      this.deps.ctx.logger.warn('scanner', 'Analysis failed', { fileId: id, error: err });
      this.deps.notifications.create({
        title: 'Dateianalyse fehlgeschlagen',
        description: `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        type: 'import_failed',
        priority: 'normal',
        dedupeKey: `analyze-failed:${id}`,
      });
      return SKIPPED;
    }
  }

  private async readContent(file: FileRow, signal?: AbortSignal): Promise<{ root: RootRow; content: FileContent }> {
    const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, file.rootId)).get();
    if (!root || !isInside(root.path, file.path)) throw permissionError('Datei liegt nicht in einem freigegebenen Verzeichnis.');
    const realPath = await fsp.realpath(file.path);
    if (!isInside(await fsp.realpath(root.path), realPath)) throw permissionError('Symbolischer Link führt aus dem freigegebenen Verzeichnis heraus.');
    const stats = await fsp.stat(realPath);
    const sha = await this.deps.pool.run('hashFile', { path: realPath }, { signal });
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
    const decision = this.deps.privacy.evaluate({ path: realPath, ext: file.ext, rootLlmAllowed: root.llmAllowed });
    const allowLlm = decision.allowed && (options.mode === 'auto' || options.confirmLlm);
    const result = await this.deps.docs.analyze(doc.id, { allowLlm, signal: options.job?.signal });
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
