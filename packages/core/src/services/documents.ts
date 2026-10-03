import fs from 'node:fs';
import path from 'node:path';
import type { DocumentRecord, DocumentStatus, TrashEntry } from '@archivist/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, scanFiles, scanRoots } from '../db/schema';
import { AppError, fsError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { LLM_ANALYSIS_ATTEMPTS } from './analysis-retry';
import type { AuditService } from './audit';
import { DocumentAnalyzer, QUARANTINE_NOT_ANALYZED, type AnalysisResult, type AnalyzeOptions } from './document-analysis';
import type { BulkPatch } from './document-bulk';
import { DocumentBatchAnalysis } from './document-batch';
import { DocumentImporter, type ImportResult } from './document-import';
import { FolderImport } from './document-import-folder';
import { DocumentIndexRepair } from './document-index';
import { DocumentMetadataEditor, type MetadataPatch } from './document-metadata';
import { DocumentReanalysis } from './document-reanalysis';
import { isArchivedStatus, type DocRow, type DocumentDeps, type NewDocument } from './document-model';
import { countDocumentList, documentCounts, queryDocumentList, type DocumentListQuery, type DocumentListRows } from './document-queries';
import { documentRecord, newDocumentRow, searchContent } from './document-record';
import { DocumentRereader } from './document-reread';
import { DocumentTrash, type FileOperationLock } from './document-trash';
import type { JobQueueService } from './jobs';
import type { KnowledgeGraphService } from './knowledge-graph';
import { NearDuplicateIndex } from './near-duplicates';
import type { DocumentPrivacyFields, PrivacyService } from './privacy';
import type { SearchService } from './search';
import type { SettingsService } from './settings';
import type { UndoService } from './undo';

export type { DocRow } from './document-model';

export const DOCUMENT_REREAD_JOB = 'documents.reread';

export type DocumentServiceDeps = Omit<DocumentDeps, 'documents' | 'nearDuplicates'> & { undo: UndoService };

export class DocumentService {
  private readonly deps: DocumentDeps;
  private readonly importer: DocumentImporter;
  private readonly analyzer: DocumentAnalyzer;
  private readonly rereader: DocumentRereader;
  private readonly metadata: DocumentMetadataEditor;
  private readonly trash: DocumentTrash;
  readonly nearDuplicates: NearDuplicateIndex;
  readonly reanalysis: DocumentReanalysis;
  readonly batch: DocumentBatchAnalysis;
  readonly folderImport: FolderImport;
  readonly indexRepair: DocumentIndexRepair;
  private fileLock: FileOperationLock = { guardedFor: (_documentId, operation) => operation() };

  private readonly ctx: AppContext;
  private readonly settings: SettingsService;
  private readonly graph: KnowledgeGraphService;
  private readonly search: SearchService;
  private readonly privacy: PrivacyService;
  private readonly audit: AuditService;
  private readonly jobs: JobQueueService;

  constructor({ undo, ...services }: DocumentServiceDeps) {
    ({ ctx: this.ctx, settings: this.settings, graph: this.graph, search: this.search, privacy: this.privacy, audit: this.audit, jobs: this.jobs } = services);
    this.nearDuplicates = new NearDuplicateIndex(services.ctx);
    this.deps = { ...services, documents: this, nearDuplicates: this.nearDuplicates };
    this.importer = new DocumentImporter(this.deps);
    this.analyzer = new DocumentAnalyzer(this.deps);
    this.reanalysis = new DocumentReanalysis(this.deps, this.analyzer);
    this.batch = new DocumentBatchAnalysis({ ctx: services.ctx, documents: this, jobs: services.jobs, notifications: services.notifications });
    this.folderImport = new FolderImport(this.deps, this.importer, this.batch);
    this.indexRepair = new DocumentIndexRepair(services.ctx, this);
    this.rereader = new DocumentRereader(this.deps);
    this.metadata = new DocumentMetadataEditor(this.deps);
    this.metadata.registerUndo(undo);
    this.trash = new DocumentTrash(this.deps, () => this.fileLock);
    this.trash.registerUndo(undo);
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Absolute path of a file in the archive. */
  archivePath(rel: string | null): string | null {
    return rel ? path.join(this.settings.get().archiveRoot, ...rel.split('/')) : null;
  }

  /** `list.textLength`: length of the full text when `r.extractedText` holds only its beginning (list queries). */
  toRecord(r: DocRow, list?: { names: Map<string, string>; textLength: number }): DocumentRecord {
    return documentRecord(r, {
      archivePath: this.archivePath(r.archiveRelPath),
      nameOf: (id) => (id ? (list?.names.get(id) ?? this.graph.getEntity(id)?.name ?? null) : null),
      textLength: list?.textLength ?? r.extractedText.length,
    });
  }

  /** The row of a document, or undefined if it does not exist (any more). */
  findRow(id: string): DocRow | undefined {
    return this.db.select().from(documents).where(eq(documents.id, id)).get();
  }

  getRow(id: string): DocRow {
    const r = this.findRow(id);
    if (!r) throw new AppError('validation_error', 'Dokument nicht gefunden.');
    return r;
  }

  get(id: string): DocumentRecord {
    return this.toRecord(this.getRow(id));
  }

  /** Newest documents matching the filter; reads only the beginning of each text for the preview (#214). */
  list(opts: DocumentListQuery = {}): DocumentRecord[] {
    return this.recordsFrom(queryDocumentList(this.db, opts));
  }

  /** Records from the rows of a list query (also when the query ran in the read worker, #215). */
  recordsFrom(result: DocumentListRows): DocumentRecord[] {
    const names = new Map(result.names);
    return result.rows.map(({ textLength, ...r }) => this.toRecord(r, { names, textLength }));
  }

  /** Number of documents per status (inbox badge) – a COUNT instead of loading the list (#214). */
  counts(): Partial<Record<DocumentStatus, number>> {
    return documentCounts(this.db);
  }

  /** Number of documents matching a list filter, regardless of the list's limit. */
  count(opts: Omit<DocumentListQuery, 'limit'> = {}): number {
    return countDocumentList(this.db, opts);
  }

  findDuplicates(sha256: string, excludeId?: string): DocRow[] {
    return this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.sha256, sha256),
          excludeId ? ne(documents.id, excludeId) : undefined,
          inArray(documents.status, ['staged', 'analyzing', 'proposed', 'archived', 'indexed_only']),
        ),
      )
      .all();
  }

  /** File upload: copied into the inbox, checked, hashed and queued for analysis; the original stays unchanged. */
  importPaths(inputPaths: string[], opts: { allowLlm?: boolean } = {}): Promise<ImportResult> {
    return this.importer.importPaths(inputPaths, opts);
  }

  /** "Import anyway" for a quarantined file; requires an explicit confirmation by the user. */
  releaseFromQuarantine(id: string, { confirmed }: { confirmed: boolean }): Promise<DocumentRecord> {
    if (!confirmed) throw new AppError('permission_error', 'Das Importieren einer Datei aus der Quarantäne erfordert eine Bestätigung.');
    return this.importer.releaseFromQuarantine(id);
  }

  /** Creates a document record (upload or scanned file). */
  insertDocument(input: NewDocument): DocumentRecord {
    const row = newDocumentRow(input, { id: newId(), at: nowIso() });
    this.db.insert(documents).values(row).run();
    this.graph.registerNode({ type: 'document', id: row.id, name: row.title, description: null });
    this.ctx.events.changed('documents', 'knowledge');
    return this.toRecord(row);
  }

  /** File to read from (preferably our own copy in the inbox). */
  readablePath(r: DocRow): string {
    for (const p of [r.stagedPath, r.sourcePath]) if (p && fs.existsSync(p)) return p;
    throw fsError('Die Quelldatei ist nicht mehr vorhanden.', { retryable: false });
  }

  /** Content analysis: extract locally, optionally classify via LLM, propose a target folder – the file is not touched. */
  analyze(id: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
    return this.analyzer.analyze(id, opts);
  }

  markAnalysisCancelled(id: string): boolean {
    return this.analyzer.markAnalysisCancelled(id);
  }

  markAnalysisFailed(id: string, err: unknown): boolean {
    return this.analyzer.markAnalysisFailed(id, err);
  }

  recoverInterruptedAnalyses(): number {
    return this.analyzer.recoverInterruptedAnalyses();
  }

  refreshIndexedOnly(id: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    return this.rereader.refreshIndexedOnly(id, opts);
  }

  rereadArchived(id: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    return this.rereader.rereadArchived(id, opts);
  }

  /** Re-reads archived documents in one job with progress (see `rereadArchived`). */
  enqueueReread(ids: string[]): string {
    return this.jobs.enqueue(DOCUMENT_REREAD_JOB, { label: `Lese ${ids.length} Dokument(e) neu`, payload: { documentIds: ids } }).id;
  }

  /** Triggers (re)processing. `allowLlm: true` corresponds to the user's explicit permission. */
  enqueueAnalysis(id: string, { allowLlm }: { allowLlm: boolean }): string {
    const doc = this.getRow(id);
    if (doc.status === 'quarantined') throw new AppError('validation_error', QUARANTINE_NOT_ANALYZED);
    if (isArchivedStatus(doc.status)) throw new AppError('validation_error', 'Archivierte oder nur indexierte Dokumente werden nicht erneut analysiert.');
    return this.jobs.enqueue('document.analyze', {
      label: `Analysiere ${doc.originalName}`,
      payload: { documentId: id, allowLlm },
      maxAttempts: LLM_ANALYSIS_ATTEMPTS,
    }).id;
  }

  /** Assigns the document to a topic/project (confirmed relations); without a file action. */
  assign(id: string, request: { topic?: string; project?: string; trigger?: string }): DocumentRecord {
    return this.metadata.assign(id, request);
  }

  updateMetadata(id: string, { patch, confirmed }: { patch: MetadataPatch; confirmed: boolean }): DocumentRecord {
    if (!confirmed) throw new AppError('permission_error', 'Das Überschreiben von Metadaten erfordert eine Bestätigung.');
    return this.metadata.updateMetadata(id, patch);
  }

  /** Sets or removes metadata of several documents at once (#291, #305); the whole batch is ONE undo step. */
  bulkUpdate(ids: string[], change: { patch: BulkPatch; trigger?: string }): { updated: DocumentRecord[]; auditId: string | null } {
    return this.metadata.bulkUpdate(ids, change);
  }

  /** Applies a re-analysis proposal to the metadata of an archived document; requires the user's confirmation (level 2). */
  applyReanalysis(id: string, { confirmed }: { confirmed: boolean }): DocumentRecord {
    if (!confirmed) throw new AppError('permission_error', 'Das Übernehmen neuer Metadaten erfordert eine Bestätigung.');
    const proposal = this.reanalysis.get(id);
    if (!proposal) throw new AppError('validation_error', 'Zu diesem Dokument liegt kein Vorschlag vor.');
    return this.metadata.applyReanalysis(id, proposal);
  }

  ignore(id: string): DocumentRecord {
    const row = this.getRow(id);
    if (row.status === 'archived') throw new AppError('validation_error', 'Archivierte Dokumente können nicht ignoriert werden.');
    this.db.update(documents).set({ status: 'ignored', archiveMode: 'ignore', updatedAt: nowIso() }).where(eq(documents.id, id)).run();
    this.audit.log({
      action: 'document.ignore',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: row.status },
      after: { status: 'ignored' },
    });
    this.ctx.events.changed('documents', 'status');
    return this.get(id);
  }

  setLlmExcluded(id: string, { excluded }: { excluded: boolean }): DocumentRecord {
    const row = this.getRow(id);
    const included = row.llmStatus === 'excluded' ? 'pending' : row.llmStatus;
    this.db
      .update(documents)
      .set({ llmStatus: excluded ? 'excluded' : included, updatedAt: nowIso() })
      .where(eq(documents.id, id))
      .run();
    this.audit.log({ action: 'document.llmExclusion', actor: 'user', trigger: 'manual', confirmed: true, entityIds: [id], after: { excluded } });
    // drop remote vectors of a now excluded document
    if (excluded) void this.indexDocument(id);
    this.ctx.events.changed('documents');
    return this.get(id);
  }

  /** false if `p` lies inside a scan folder whose LLM permission is withdrawn. */
  folderLlmAllowedFor(p: string): boolean {
    const locked = this.db.select({ path: scanRoots.path }).from(scanRoots).where(eq(scanRoots.llmAllowed, false)).all();
    return !locked.some((r) => this.privacy.paths.inside(r.path, p));
  }

  /** Stores a scan folder's LLM permission on the documents found in it (other locked folders still apply); returns how many changed. */
  applyFolderPermission(rootId: string): number {
    const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, rootId)).get();
    if (!root) return 0;
    const linked = new Set(
      this.db
        .select({ documentId: scanFiles.documentId })
        .from(scanFiles)
        .where(eq(scanFiles.rootId, rootId))
        .all()
        .flatMap((f) => (f.documentId ? [f.documentId] : [])),
    );
    const rows = this.db
      .select({ id: documents.id, sourcePath: documents.sourcePath, folderLlmAllowed: documents.folderLlmAllowed })
      .from(documents)
      .all()
      .filter((d) => linked.has(d.id) || (d.sourcePath !== null && this.privacy.paths.inside(root.path, d.sourcePath)));
    let changed = 0;
    for (const d of rows) {
      const allowed = root.llmAllowed && (d.sourcePath === null || this.folderLlmAllowedFor(d.sourcePath));
      if (allowed === d.folderLlmAllowed) continue;
      this.db.update(documents).set({ folderLlmAllowed: allowed }).where(eq(documents.id, d.id)).run();
      // remote vectors of a newly locked document are replaced by local ones
      if (!allowed) void this.indexDocument(d.id);
      changed += 1;
    }
    if (changed) this.ctx.events.changed('documents');
    return changed;
  }

  /** Updates the search index for archived/indexed documents. */
  async indexDocument(id: string): Promise<void> {
    try {
      const r = this.getRow(id);
      if (!isArchivedStatus(r.status)) {
        this.search.remove(id);
        return;
      }
      const names = new Map<string, string>();
      for (const entityId of [r.topicId, r.projectId]) if (entityId) names.set(entityId, this.graph.getEntity(entityId)?.name ?? '');
      await this.search.index({
        type: 'document',
        id,
        title: r.title,
        content: searchContent(r, names),
        allowRemoteEmbedding: this.remoteEmbeddingAllowed(r),
      });
    } catch (err) {
      this.ctx.logger.warn('documents', 'Indexing failed', { documentId: id, error: err });
    }
  }

  /** Whether indexing would give the document remote vectors now (#173); false for an unknown id. */
  embedsRemotely(id: string): boolean {
    const row = this.db
      .select({ sourcePath: documents.sourcePath, ext: documents.ext, llmStatus: documents.llmStatus, folderLlmAllowed: documents.folderLlmAllowed })
      .from(documents)
      .where(eq(documents.id, id))
      .get();
    return row !== undefined && this.remoteEmbeddingAllowed(row);
  }

  /** Remote vectors only in mode „automatisch“; in „vorher fragen“ the index stays local (no unconfirmed transfer). */
  private remoteEmbeddingAllowed(row: DocumentPrivacyFields): boolean {
    return this.privacy.mode() === 'auto' && row.llmStatus === 'analyzed' && this.privacy.evaluateDocument(row).allowed;
  }

  /** The archive's file locks, set by the archive service, so trash moves never run into archive operations. */
  useFileLock(lock: FileOperationLock): void {
    this.fileLock = lock;
  }

  /** Deleting with a safety net (level 2): the document goes to the trash and can be restored via undo. */
  moveToTrash(id: string, opts: { confirmed: boolean; trigger: string }): Promise<{ auditId: string }> {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Löschen eines Dokuments erfordert eine ausdrückliche Bestätigung.');
    return this.trash.moveToTrash({ id, trigger: opts.trigger });
  }

  trashEntries(): TrashEntry[] {
    return this.trash.list();
  }

  /** Empties the trash for good (level 3: second explicit confirmation). */
  emptyTrash(request: { confirmed: boolean; permanentlyConfirmed: boolean }): Promise<{ deletedFiles: number; documents: number }> {
    return this.trash.empty(request);
  }
}
