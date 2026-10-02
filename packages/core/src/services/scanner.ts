import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Job, ScanExclusion, ScanFile, ScanFileStatus, ScanProposalGroup, ScanRoot, ScanSummary } from '@archivist/shared';
import { and, desc, eq, inArray, like, ne, or } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, scanExclusions, scanFiles, scanRoots } from '../db/schema';
import { AppError, permissionError, validationError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { isForbiddenScanRoot, isInside, normalizeFsPath } from '../util/paths';
import type { WorkerPool } from '../workers/pool';
import { SCAN_MAX_FILES } from '../workers/tasks';
import type { AuditService } from './audit';
import type { DocumentService } from './documents';
import type { InsightService } from './insights';
import type { JobContext, JobQueueService } from './jobs';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { NotificationService } from './notifications';
import type { PrivacyService } from './privacy';
import { IntervalSchedule } from './scheduler';
import { FileAnalysis } from './scanner/file-analysis';
import { ScanProposals } from './scanner/proposals';
import { mapFile, mapRoot, type RootRow } from './scanner/scan-files';
import { ScanRun } from './scanner/scan-run';
import type { SettingsService } from './settings';

const mapExclusion = (row: typeof scanExclusions.$inferSelect): ScanExclusion => ({
  id: row.id,
  kind: row.kind as 'file' | 'dir',
  path: row.path,
  createdAt: row.createdAt,
});

/** Controlled scan of explicitly approved directories; a plain file scan never sends content to the LLM, originals stay untouched. */
export class ScannerService {
  /** Periodic scan; armed by startSchedule(), re-applied by applySettings() on every relevant change */
  private readonly schedule: IntervalSchedule;
  private readonly scans: ScanRun;
  private readonly analysis: FileAnalysis;
  private readonly scanProposals: ScanProposals;
  /** Upper bound of files collected per scan root (lowered in tests). */
  maxFilesPerRoot = SCAN_MAX_FILES;

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    pool: WorkerPool,
    private readonly docs: DocumentService,
    graph: KnowledgeGraphService,
    privacy: PrivacyService,
    notifications: NotificationService,
    insights: InsightService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {
    this.schedule = new IntervalSchedule({ name: 'scanner', run: () => this.periodicScan(), logger: ctx.logger });
    this.scans = new ScanRun({ ctx, settings, pool, docs, privacy, notifications, maxFilesPerRoot: () => this.maxFilesPerRoot });
    this.analysis = new FileAnalysis({ ctx, pool, docs, graph, privacy, notifications });
    this.scanProposals = new ScanProposals({ ctx, graph, insights, notifications });
    ctx.events.on('document:archived', (event: { documentId: string; sourcePath: string | null }) => {
      if (!event.sourcePath) return;
      this.db.update(scanFiles).set({ status: 'archived', documentId: event.documentId }).where(eq(scanFiles.path, event.sourcePath)).run();
      this.ctx.events.changed('scanner');
    });
    ctx.events.on('document:unarchived', (event: { documentId: string }) => this.resetAfterUnarchive(event.documentId));
  }

  /** Undo of an archiving: the document's `archived` scan files become processable again (proposal or new analysis). */
  private resetAfterUnarchive(documentId: string): void {
    const doc = this.db.select().from(documents).where(eq(documents.id, documentId)).get();
    const files = this.db
      .select()
      .from(scanFiles)
      .where(and(eq(scanFiles.documentId, documentId), eq(scanFiles.status, 'archived')))
      .all();
    if (!files.length) return;
    for (const file of files) {
      // undo may have put the archived version back under another name: the file at file.path is then a different one
      const sameFile = doc?.sourcePath === file.path;
      this.db
        .update(scanFiles)
        .set({
          status: sameFile && doc?.status === 'proposed' ? 'analyzed' : 'new',
          documentId: sameFile ? documentId : null,
          duplicateOfDocumentId: null,
        })
        .where(eq(scanFiles.id, file.id))
        .run();
    }
    this.ctx.events.changed('scanner');
  }

  private get db() {
    return this.ctx.database.db;
  }

  private rootRow(id: string): RootRow {
    const row = this.db.select().from(scanRoots).where(eq(scanRoots.id, id)).get();
    if (!row) throw validationError('Verzeichnis nicht gefunden.');
    return row;
  }

  // ---------- Directories ----------
  async addDirectory(dir: string, recursive = true): Promise<ScanRoot> {
    if (!path.isAbsolute(dir) || dir.includes('\0')) throw validationError('Bitte einen absoluten Verzeichnispfad angeben.');
    let real: string;
    try {
      real = normalizeFsPath(await fsp.realpath(dir));
    } catch {
      throw validationError('Das Verzeichnis existiert nicht oder ist nicht lesbar.', dir);
    }
    if (!(await fsp.stat(real)).isDirectory()) throw validationError('Das ist kein Verzeichnis.');
    const forbidden = isForbiddenScanRoot(real);
    if (forbidden) throw permissionError(forbidden, real);
    const ownRoots = [this.ctx.paths.root, this.settings.get().archiveRoot].map((ownRoot) => normalizeFsPath(ownRoot));
    if (ownRoots.some((ownRoot) => isInside(ownRoot, real))) throw permissionError('Das Archivist-Datenverzeichnis selbst kann nicht gescannt werden.', real);
    if (this.db.select().from(scanRoots).where(eq(scanRoots.path, real)).get()) throw validationError('Dieses Verzeichnis ist bereits freigegeben.');
    const scan = this.settings.get().scan;
    const row: RootRow = {
      id: newId(),
      path: real,
      enabled: true,
      recursive,
      excludedSubdirs: [],
      extensions: scan.allowedExtensions,
      maxFileSizeMb: scan.maxFileSizeMb,
      llmAllowed: true,
      lastScanAt: null,
      lastSummary: null,
      createdAt: nowIso(),
    };
    this.db.insert(scanRoots).values(row).run();
    this.audit.log({ action: 'scanner.addDirectory', actor: 'user', trigger: 'manual', confirmed: true, paths: [real] });
    this.ctx.events.changed('scanner');
    return mapRoot(row);
  }

  removeDirectory(id: string): void {
    const row = this.rootRow(id);
    this.db.delete(scanFiles).where(eq(scanFiles.rootId, id)).run();
    this.db.delete(scanRoots).where(eq(scanRoots.id, id)).run();
    this.audit.log({ action: 'scanner.removeDirectory', actor: 'user', trigger: 'manual', confirmed: true, paths: [row.path] });
    this.ctx.events.changed('scanner');
  }

  updateDirectory(
    id: string,
    patch: Partial<Pick<ScanRoot, 'enabled' | 'recursive' | 'excludedSubdirs' | 'extensions' | 'maxFileSizeMb' | 'llmAllowed'>>,
  ): ScanRoot {
    const row = this.rootRow(id);
    const set: Partial<RootRow> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.recursive !== undefined) set.recursive = patch.recursive;
    if (patch.excludedSubdirs) set.excludedSubdirs = patch.excludedSubdirs;
    if (patch.extensions) set.extensions = patch.extensions.map((extension) => extension.toLowerCase().replace(/^\./, ''));
    if (patch.maxFileSizeMb !== undefined) set.maxFileSizeMb = patch.maxFileSizeMb;
    if (patch.llmAllowed !== undefined) set.llmAllowed = patch.llmAllowed;
    this.db.update(scanRoots).set(set).where(eq(scanRoots.id, id)).run();
    // the folder permission is stored on the documents, so every analysis, chat and search path honours it
    if (patch.llmAllowed !== undefined && patch.llmAllowed !== row.llmAllowed) this.docs.applyFolderPermission(id);
    this.ctx.events.changed('scanner');
    return mapRoot({ ...row, ...set });
  }

  listDirectories(): ScanRoot[] {
    return this.db.select().from(scanRoots).orderBy(scanRoots.path).all().map(mapRoot);
  }

  // ---------- Exclusions ----------
  exclude(kind: 'file' | 'dir', target: string): ScanExclusion {
    if (!path.isAbsolute(target)) throw validationError('Bitte einen absoluten Pfad angeben.');
    const absolute = normalizeFsPath(target);
    const existing = this.db
      .select()
      .from(scanExclusions)
      .where(and(eq(scanExclusions.kind, kind), eq(scanExclusions.path, absolute)))
      .get();
    const row = existing ?? { id: newId(), kind, path: absolute, createdAt: nowIso() };
    if (!existing) this.db.insert(scanExclusions).values(row).run();
    const below = `${absolute}${path.sep}%`;
    const files = this.db
      .select()
      .from(scanFiles)
      .where(kind === 'file' ? eq(scanFiles.path, absolute) : like(scanFiles.path, below))
      .all();
    for (const file of files) this.db.update(scanFiles).set({ status: 'excluded' }).where(eq(scanFiles.id, file.id)).run();
    // remove not yet archived documents from this location from the inbox
    const inboxDocs = this.db
      .select()
      .from(documents)
      .where(and(inArray(documents.status, ['staged', 'proposed']), kind === 'file' ? eq(documents.sourcePath, absolute) : like(documents.sourcePath, below)))
      .all();
    for (const doc of inboxDocs)
      if (!doc.stagedPath) this.db.update(documents).set({ status: 'ignored', updatedAt: nowIso() }).where(eq(documents.id, doc.id)).run();
    this.audit.log({ action: `scanner.exclude.${kind}`, actor: 'user', trigger: 'manual', confirmed: true, paths: [absolute] });
    this.ctx.events.changed('scanner', 'documents');
    return mapExclusion(row);
  }

  listExclusions(): ScanExclusion[] {
    return this.db.select().from(scanExclusions).orderBy(desc(scanExclusions.createdAt)).all().map(mapExclusion);
  }

  removeExclusion(id: string): void {
    const row = this.db.select().from(scanExclusions).where(eq(scanExclusions.id, id)).get();
    if (!row) return;
    this.db.delete(scanExclusions).where(eq(scanExclusions.id, id)).run();
    // the files are picked up again on the next scan
    this.db
      .delete(scanFiles)
      .where(and(eq(scanFiles.status, 'excluded'), or(eq(scanFiles.path, row.path), like(scanFiles.path, `${row.path}${path.sep}%`))))
      .run();
    this.audit.log({ action: 'scanner.removeExclusion', actor: 'user', trigger: 'manual', confirmed: true, paths: [row.path] });
    this.ctx.events.changed('scanner');
  }

  // ---------- Scan ----------
  /** Master switch „Lokale Dokumentensuche“ (off by default). */
  startScan(rootId?: string, trigger = 'manual'): Job {
    if (!this.settings.get().scan.enabled)
      throw permissionError('Die lokale Dokumentensuche ist deaktiviert. Bitte zuerst in den Scan-Einstellungen aktivieren.');
    const roots = this.listDirectories().filter((root) => root.enabled && (!rootId || root.id === rootId));
    if (roots.length === 0) throw validationError('Es ist kein freigegebenes Scan-Verzeichnis vorhanden.');
    // a queued or running scan of the same folder (or of all) covers this one: two scans of a folder would collide on its rows
    return this.jobs.enqueue<{ rootId: string | null; trigger: string }>(
      'scanner.scan',
      rootId ? `Scan ${path.basename(roots[0]!.path)}` : 'Scan aller freigegebenen Verzeichnisse',
      { rootId: rootId ?? null, trigger },
      { maxAttempts: 1, sameAs: (active) => active.rootId === null || active.rootId === (rootId ?? null) },
    );
  }

  runScan(rootId: string | null, job?: JobContext): Promise<ScanSummary[]> {
    return this.scans.run(rootId, job);
  }

  getResults(options: { rootId?: string; status?: ScanFileStatus; limit?: number } = {}): { files: ScanFile[]; lastSummary: ScanSummary | null } {
    const conditions = [];
    if (options.rootId) conditions.push(eq(scanFiles.rootId, options.rootId));
    if (options.status) conditions.push(eq(scanFiles.status, options.status));
    const files = this.db
      .select()
      .from(scanFiles)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(scanFiles.lastSeenAt), scanFiles.name)
      .limit(options.limit ?? 500)
      .all()
      .map(mapFile);
    const latest = this.db
      .select()
      .from(scanRoots)
      .orderBy(desc(scanRoots.lastScanAt))
      .all()
      .find((root) => root.lastSummary);
    return { files, lastSummary: (latest?.lastSummary as unknown as ScanSummary | null) ?? null };
  }

  /** New or changed analysable files not queued yet, oldest first – unlike the result list, not always the same first ones (#222). */
  filesAwaitingAnalysis(): string[] {
    const queued = new Set(this.jobs.activePayloads<{ fileIds?: string[] }>('scanner.analyze').flatMap((payload) => payload.fileIds ?? []));
    return this.db
      .select({ id: scanFiles.id })
      .from(scanFiles)
      .where(and(inArray(scanFiles.status, ['new', 'changed']), ne(scanFiles.llmStatus, 'excluded')))
      .orderBy(scanFiles.firstSeenAt, scanFiles.path)
      .all()
      .map((row) => row.id)
      .filter((id) => !queued.has(id));
  }

  getFile(id: string): ScanFile {
    const row = this.db.select().from(scanFiles).where(eq(scanFiles.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Scan-Datei nicht gefunden.');
    return mapFile(row);
  }

  /** Opens a path only if it belongs to an approved root (no arbitrary opening). */
  assertOpenable(file: ScanFile): string {
    const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, file.rootId)).get();
    if (!root || !isInside(root.path, file.path)) throw permissionError('Die Datei liegt nicht in einem freigegebenen Verzeichnis.');
    return file.path;
  }

  // ---------- Content analysis ----------
  /** Analyzes selected files. Only here (and only with confirmLlm / mode „auto“) can content go to the LLM. */
  async analyzeFiles(fileIds: string[], confirmLlm: boolean, job?: JobContext): Promise<{ analyzed: string[]; skipped: string[] }> {
    const result = await this.analysis.analyzeFiles(fileIds, { confirmLlm, job });
    this.buildProposals(result.analyzed);
    this.ctx.events.changed('scanner', 'documents', 'status');
    return result;
  }

  /** Assignment proposals: groups analyzed documents by topic/project and creates an insight, an action and a notification. */
  buildProposals(docIds: string[]): void {
    this.scanProposals.build(docIds);
  }

  /** Proposal groups for the scan view (analyzed scan documents that are not archived yet). */
  proposals(): ScanProposalGroup[] {
    return this.scanProposals.groups();
  }

  // ---------- Scheduling (only while the application runs) ----------
  /** Starts the periodic scan according to the current settings and folders. */
  startSchedule(): void {
    this.applySettings();
    this.schedule.start();
  }

  /** Re-plans the periodic scan from settings and enabled folders; cheap and idempotent, an unchanged plan keeps its timer. */
  applySettings(): void {
    const scan = this.settings.get().scan;
    const active = scan.enabled && scan.periodic && this.listDirectories().some((root) => root.enabled);
    this.schedule.setInterval(active ? scan.intervalMinutes * 60_000 : null);
  }

  /** When the next periodic scan is due (epoch ms), or null if none is planned. */
  nextPeriodicScanAt(): number | null {
    return this.schedule.nextRunAt();
  }

  private periodicScan(): void {
    try {
      this.startScan(undefined, 'interval');
    } catch (err) {
      this.ctx.logger.warn('scanner', 'Periodic scan not started', { error: err });
    }
  }

  startupScan(): void {
    const scan = this.settings.get().scan;
    if (!scan.enabled || !scan.onStartup || this.listDirectories().length === 0) return;
    try {
      this.startScan(undefined, 'startup');
    } catch (err) {
      this.ctx.logger.warn('scanner', 'Startup scan not started', { error: err });
    }
  }

  stop(): void {
    this.schedule.stop();
  }

  fileExists(target: string): boolean {
    return fs.existsSync(target);
  }
}
