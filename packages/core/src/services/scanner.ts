import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DocumentProposal, Job, ScanFile, ScanFileStatus, ScanRoot, ScanSummary } from '@archivist/shared';
import type { ScanExclusion, ScanProposalGroup } from '@archivist/shared';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, scanExclusions, scanFiles, scanRoots } from '../db/schema';
import { MIME_BY_EXT } from '../parsers';
import { AppError, permissionError, validationError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { isForbiddenScanRoot, isInside, normalizeFsPath } from '../util/paths';
import type { WorkerPool } from '../workers/pool';
import type { AuditService } from './audit';
import type { DocumentService } from './documents';
import type { InsightService } from './insights';
import type { JobContext, JobQueueService } from './jobs';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { NotificationService } from './notifications';
import type { PrivacyService } from './privacy';
import type { SettingsService } from './settings';

type RootRow = typeof scanRoots.$inferSelect;
type FileRow = typeof scanFiles.$inferSelect;

const mapRoot = (r: RootRow): ScanRoot => ({
  id: r.id,
  path: r.path,
  enabled: r.enabled,
  recursive: r.recursive,
  excludedSubdirs: r.excludedSubdirs,
  extensions: r.extensions,
  maxFileSizeMb: r.maxFileSizeMb,
  llmAllowed: r.llmAllowed,
  lastScanAt: r.lastScanAt,
  createdAt: r.createdAt,
});

const mapFile = (r: FileRow): ScanFile => ({
  id: r.id,
  rootId: r.rootId,
  path: r.path,
  name: r.name,
  ext: r.ext,
  size: r.size,
  mtimeMs: r.mtimeMs,
  sha256: r.sha256,
  mime: r.mime,
  status: r.status as ScanFileStatus,
  llmStatus: r.llmStatus as ScanFile['llmStatus'],
  documentId: r.documentId,
  duplicateOfDocumentId: r.duplicateOfDocumentId,
  firstSeenAt: r.firstSeenAt,
  lastSeenAt: r.lastSeenAt,
});

/**
 * Kontrollierter Verzeichnisscan. Es werden ausschließlich ausdrücklich freigegebene Verzeichnisse untersucht;
 * ein reiner Dateiscan sendet nie Inhalte an das LLM. Originale werden nie verändert.
 */
export class ScannerService {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly pool: WorkerPool,
    private readonly docs: DocumentService,
    private readonly graph: KnowledgeGraphService,
    private readonly privacy: PrivacyService,
    private readonly notifications: NotificationService,
    private readonly insights: InsightService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {
    ctx.events.on('document:archived', (e: { documentId: string; sourcePath: string | null }) => {
      if (!e.sourcePath) return;
      this.db.update(scanFiles).set({ status: 'archived', documentId: e.documentId }).where(eq(scanFiles.path, e.sourcePath)).run();
      this.ctx.events.changed('scanner');
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  // ---------- Verzeichnisse ----------
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
    const roots = [this.ctx.paths.root, this.settings.get().archiveRoot].map((p) => normalizeFsPath(p));
    if (roots.some((r) => isInside(r, real))) throw permissionError('Das Archivist-Datenverzeichnis selbst kann nicht gescannt werden.', real);
    if (this.db.select().from(scanRoots).where(eq(scanRoots.path, real)).get()) throw validationError('Dieses Verzeichnis ist bereits freigegeben.');
    const s = this.settings.get().scan;
    const row: RootRow = {
      id: newId(),
      path: real,
      enabled: true,
      recursive,
      excludedSubdirs: [],
      extensions: s.allowedExtensions,
      maxFileSizeMb: s.maxFileSizeMb,
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
    const row = this.db.select().from(scanRoots).where(eq(scanRoots.id, id)).get();
    if (!row) throw validationError('Verzeichnis nicht gefunden.');
    this.db.delete(scanFiles).where(eq(scanFiles.rootId, id)).run();
    this.db.delete(scanRoots).where(eq(scanRoots.id, id)).run();
    this.audit.log({ action: 'scanner.removeDirectory', actor: 'user', trigger: 'manual', confirmed: true, paths: [row.path] });
    this.ctx.events.changed('scanner');
  }

  updateDirectory(
    id: string,
    patch: Partial<Pick<ScanRoot, 'enabled' | 'recursive' | 'excludedSubdirs' | 'extensions' | 'maxFileSizeMb' | 'llmAllowed'>>,
  ): ScanRoot {
    const row = this.db.select().from(scanRoots).where(eq(scanRoots.id, id)).get();
    if (!row) throw validationError('Verzeichnis nicht gefunden.');
    const set: Partial<RootRow> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.recursive !== undefined) set.recursive = patch.recursive;
    if (patch.excludedSubdirs) set.excludedSubdirs = patch.excludedSubdirs;
    if (patch.extensions) set.extensions = patch.extensions.map((e) => e.toLowerCase().replace(/^\./, ''));
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

  // ---------- Ausschlüsse ----------
  exclude(kind: 'file' | 'dir', p: string): ScanExclusion {
    if (!path.isAbsolute(p)) throw validationError('Bitte einen absoluten Pfad angeben.');
    const abs = normalizeFsPath(p);
    const existing = this.db
      .select()
      .from(scanExclusions)
      .where(and(eq(scanExclusions.kind, kind), eq(scanExclusions.path, abs)))
      .get();
    const row = existing ?? { id: newId(), kind, path: abs, createdAt: nowIso() };
    if (!existing) this.db.insert(scanExclusions).values(row).run();
    const files = this.db
      .select()
      .from(scanFiles)
      .where(kind === 'file' ? eq(scanFiles.path, abs) : like(scanFiles.path, `${abs}${path.sep}%`))
      .all();
    for (const f of files) this.db.update(scanFiles).set({ status: 'excluded' }).where(eq(scanFiles.id, f.id)).run();
    // noch nicht archivierte Dokumente aus diesem Ort aus dem Eingang nehmen
    const docs = this.db
      .select()
      .from(documents)
      .where(
        and(
          inArray(documents.status, ['staged', 'proposed']),
          kind === 'file' ? eq(documents.sourcePath, abs) : like(documents.sourcePath, `${abs}${path.sep}%`),
        ),
      )
      .all();
    for (const d of docs) if (!d.stagedPath) this.db.update(documents).set({ status: 'ignored', updatedAt: nowIso() }).where(eq(documents.id, d.id)).run();
    this.audit.log({ action: `scanner.exclude.${kind}`, actor: 'user', trigger: 'manual', confirmed: true, paths: [abs] });
    this.ctx.events.changed('scanner', 'documents');
    return { id: row.id, kind: row.kind as 'file' | 'dir', path: row.path, createdAt: row.createdAt };
  }

  listExclusions(): ScanExclusion[] {
    return this.db
      .select()
      .from(scanExclusions)
      .orderBy(desc(scanExclusions.createdAt))
      .all()
      .map((r) => ({ id: r.id, kind: r.kind as 'file' | 'dir', path: r.path, createdAt: r.createdAt }));
  }

  removeExclusion(id: string): void {
    const row = this.db.select().from(scanExclusions).where(eq(scanExclusions.id, id)).get();
    if (!row) return;
    this.db.delete(scanExclusions).where(eq(scanExclusions.id, id)).run();
    // Dateien werden beim nächsten Scan wieder erfasst
    this.db
      .delete(scanFiles)
      .where(and(eq(scanFiles.status, 'excluded'), or(eq(scanFiles.path, row.path), like(scanFiles.path, `${row.path}${path.sep}%`))))
      .run();
    this.audit.log({ action: 'scanner.removeExclusion', actor: 'user', trigger: 'manual', confirmed: true, paths: [row.path] });
    this.ctx.events.changed('scanner');
  }

  // ---------- Scan ----------
  /** Master-Schalter „Lokale Dokumentensuche“ (standardmäßig aus). */
  startScan(rootId?: string, trigger = 'manual'): Job {
    if (!this.settings.get().scan.enabled)
      throw permissionError('Die lokale Dokumentensuche ist deaktiviert. Bitte zuerst in den Scan-Einstellungen aktivieren.');
    const roots = this.listDirectories().filter((r) => r.enabled && (!rootId || r.id === rootId));
    if (roots.length === 0) throw validationError('Es ist kein freigegebenes Scan-Verzeichnis vorhanden.');
    return this.jobs.enqueue(
      'scanner.scan',
      rootId ? `Scan ${path.basename(roots[0]!.path)}` : 'Scan aller freigegebenen Verzeichnisse',
      { rootId: rootId ?? null, trigger },
      { maxAttempts: 1 },
    );
  }

  private isDup(sha: string): string | null {
    return (
      this.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.sha256, sha), inArray(documents.status, ['archived', 'indexed_only'])))
        .get()?.id ?? null
    );
  }

  async runScan(rootId: string | null, job?: JobContext): Promise<ScanSummary[]> {
    const roots = this.db
      .select()
      .from(scanRoots)
      .where(rootId ? eq(scanRoots.id, rootId) : eq(scanRoots.enabled, true))
      .all();
    const summaries: ScanSummary[] = [];
    const exclusions = this.db.select().from(scanExclusions).all();
    let idx = 0;
    for (const root of roots) {
      job?.throwIfCancelled();
      idx += 1;
      const summary: ScanSummary = {
        rootId: root.id,
        scanned: 0,
        newFiles: 0,
        changedFiles: 0,
        unchanged: 0,
        excluded: 0,
        skipped: 0,
        duplicates: 0,
        errors: [],
      };
      try {
        const real = await fsp.realpath(root.path); // Verzeichnis könnte inzwischen entfernt/ersetzt worden sein
        if (isForbiddenScanRoot(real)) throw permissionError('Verzeichnis ist nicht (mehr) für Scans zulässig.', real);
        job?.report((idx - 1) / roots.length, `Durchsuche ${root.path}`);
        const walked = await this.pool.run('scanDirectory', {
          root: real,
          recursive: root.recursive,
          excludedDirs: [
            ...exclusions.filter((e) => e.kind === 'dir').map((e) => e.path),
            ...root.excludedSubdirs.map((d) => (path.isAbsolute(d) ? d : path.join(real, d))),
            this.ctx.paths.root,
            this.settings.get().archiveRoot,
          ],
          excludedFiles: exclusions.filter((e) => e.kind === 'file').map((e) => e.path),
          extensions: root.extensions,
          maxSizeBytes: root.maxFileSizeMb * 1024 * 1024,
        });
        summary.errors.push(...walked.errors.slice(0, 20));
        summary.skipped = walked.skipped.length;
        const known = new Map(
          this.db
            .select()
            .from(scanFiles)
            .where(eq(scanFiles.rootId, root.id))
            .all()
            .map((f) => [f.path, f]),
        );
        const seen = new Set<string>();
        const now = nowIso();
        for (const e of walked.entries) {
          job?.throwIfCancelled();
          seen.add(e.path);
          summary.scanned += 1;
          const prev = known.get(e.path);
          if (prev?.status === 'excluded') {
            summary.excluded += 1;
            continue;
          }
          // bekannt und unverändert → nicht erneut hashen/analysieren
          if (prev && prev.size === e.size && prev.mtimeMs === e.mtimeMs) {
            this.db.update(scanFiles).set({ lastSeenAt: now }).where(eq(scanFiles.id, prev.id)).run();
            summary.unchanged += 1;
            continue;
          }
          let sha: string;
          try {
            sha = await this.pool.run('hashFile', { path: e.path });
          } catch (err) {
            summary.errors.push(`${e.path}: ${(err as Error).message}`);
            continue;
          }
          const decision = this.privacy.evaluate({ path: e.path, ext: e.ext, rootLlmAllowed: root.llmAllowed });
          const llmStatus = decision.allowed ? 'local_only' : (decision.status ?? 'local_only');
          const dupOf = this.isDup(sha);
          if (prev) {
            const wasArchived = prev.status === 'archived' || prev.status === 'analyzed';
            const status: ScanFileStatus = dupOf ? 'duplicate' : 'changed';
            this.db
              .update(scanFiles)
              .set({ size: e.size, mtimeMs: e.mtimeMs, sha256: sha, status, llmStatus, duplicateOfDocumentId: dupOf, lastSeenAt: now })
              .where(eq(scanFiles.id, prev.id))
              .run();
            summary.changedFiles += 1;
            if (wasArchived && prev.sha256 !== sha) {
              this.notifications.create({
                title: 'Datei seit Archivierung verändert',
                description: `„${e.name}“ in ${path.dirname(e.path)} wurde nach der Archivierung geändert.`,
                type: 'file_changed',
                priority: 'normal',
                affectedEntityIds: prev.documentId ? [prev.documentId] : [],
                proposedActions: [{ label: 'Scan-Ergebnisse prüfen', kind: 'navigate', target: '/scan/' }],
                dedupeKey: `file-changed:${prev.id}:${sha}`,
              });
            }
          } else {
            this.db
              .insert(scanFiles)
              .values({
                id: newId(),
                rootId: root.id,
                path: e.path,
                name: e.name,
                ext: e.ext,
                size: e.size,
                mtimeMs: e.mtimeMs,
                sha256: sha,
                mime: MIME_BY_EXT[e.ext] ?? e.mime,
                status: dupOf ? 'duplicate' : 'new',
                llmStatus,
                documentId: null,
                duplicateOfDocumentId: dupOf,
                firstSeenAt: now,
                lastSeenAt: now,
              })
              .run();
            summary.newFiles += 1;
          }
          if (dupOf) summary.duplicates += 1;
        }
        // verschwundene, noch nicht verarbeitete Dateien aus der Liste nehmen
        for (const [p, f] of known)
          if (!seen.has(p) && ['new', 'changed', 'known', 'duplicate'].includes(f.status)) this.db.delete(scanFiles).where(eq(scanFiles.id, f.id)).run();
        this.db.update(scanRoots).set({ lastScanAt: now, lastSummary: summary }).where(eq(scanRoots.id, root.id)).run();
        this.notifyScan(root, summary);
      } catch (err) {
        if (err instanceof Error && err.name === 'JobCancelledError') throw err;
        summary.errors.push(err instanceof Error ? err.message : String(err));
        this.ctx.logger.error('scanner', 'Scan fehlgeschlagen', { root: root.path, error: err });
        this.notifications.create({
          title: 'Scan teilweise fehlgeschlagen',
          description: `${root.path}: ${summary.errors[summary.errors.length - 1]}`,
          type: 'scan_partial',
          priority: 'high',
          proposedActions: [{ label: 'Scan-Verzeichnis verwalten', kind: 'navigate', target: '/scan/' }],
        });
      }
      summaries.push(summary);
    }
    this.ctx.events.changed('scanner', 'status');
    return summaries;
  }

  private notifyScan(root: RootRow, s: ScanSummary): void {
    const fresh = s.newFiles + s.changedFiles;
    if (fresh > 0) {
      this.notifications.create({
        title: `${fresh} neue oder geänderte Dokumente gefunden`,
        description: `${path.basename(root.path)}: ${s.newFiles} neu, ${s.changedFiles} geändert, ${s.duplicates} mögliche Duplikate, ${s.unchanged} unverändert übersprungen.`,
        type: 'scan_new_files',
        priority: 'normal',
        proposedActions: [{ label: 'Scan-Ergebnisse prüfen', kind: 'navigate', target: '/scan/' }],
        dedupeKey: `scan-new:${root.id}:${s.scanned}:${fresh}:${s.duplicates}`,
      });
    }
    if (s.duplicates > 0) {
      this.notifications.create({
        title: `${s.duplicates} Datei(en) entsprechen bereits archivierten Dokumenten`,
        description: `In ${path.basename(root.path)} liegen mögliche externe Duplikate.`,
        type: 'external_duplicate',
        priority: 'low',
        proposedActions: [{ label: 'Scan-Ergebnisse prüfen', kind: 'navigate', target: '/scan/' }],
        dedupeKey: `scan-dup:${root.id}:${s.duplicates}:${s.scanned}`,
      });
    }
    this.notifications.create({
      title: s.errors.length ? 'Scan teilweise fehlgeschlagen' : 'Scan abgeschlossen',
      description: `${path.basename(root.path)}: ${s.scanned} Dateien geprüft, ${s.unchanged} unverändert übersprungen${s.errors.length ? `, ${s.errors.length} Fehler` : ''}.`,
      type: s.errors.length ? 'scan_partial' : 'scan_done',
      priority: s.errors.length ? 'high' : 'low',
      proposedActions: [{ label: 'Scan-Ergebnisse prüfen', kind: 'navigate', target: '/scan/' }],
      dedupeKey: `scan-done:${root.id}:${Date.now()}`,
    });
  }

  getResults(opts: { rootId?: string; status?: ScanFileStatus; limit?: number } = {}): { files: ScanFile[]; lastSummary: ScanSummary | null } {
    const conds = [];
    if (opts.rootId) conds.push(eq(scanFiles.rootId, opts.rootId));
    if (opts.status) conds.push(eq(scanFiles.status, opts.status));
    const files = this.db
      .select()
      .from(scanFiles)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(scanFiles.lastSeenAt), scanFiles.name)
      .limit(opts.limit ?? 500)
      .all()
      .map(mapFile);
    const latest = this.db
      .select()
      .from(scanRoots)
      .orderBy(desc(scanRoots.lastScanAt))
      .all()
      .find((r) => r.lastSummary);
    return { files, lastSummary: (latest?.lastSummary as unknown as ScanSummary | null) ?? null };
  }

  getFile(id: string): ScanFile {
    const r = this.db.select().from(scanFiles).where(eq(scanFiles.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Scan-Datei nicht gefunden.');
    return mapFile(r);
  }

  /** Pfad nur öffnen, wenn er zu einer freigegebenen Wurzel gehört (kein beliebiges Öffnen). */
  assertOpenable(file: ScanFile): string {
    const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, file.rootId)).get();
    if (!root || !isInside(root.path, file.path)) throw permissionError('Die Datei liegt nicht in einem freigegebenen Verzeichnis.');
    return file.path;
  }

  // ---------- Inhaltliche Analyse ----------
  /** Analysiert ausgewählte Dateien. Nur hier (und nur mit confirmLlm / Modus „auto“) können Inhalte an das LLM gehen. */
  async analyzeFiles(fileIds: string[], confirmLlm: boolean, job?: JobContext): Promise<{ analyzed: string[]; skipped: string[] }> {
    const analyzed: string[] = [];
    const skipped: string[] = [];
    const mode = this.privacy.mode();
    let i = 0;
    for (const id of fileIds) {
      job?.throwIfCancelled();
      i += 1;
      const f = this.db.select().from(scanFiles).where(eq(scanFiles.id, id)).get();
      if (!f || f.status === 'excluded') {
        skipped.push(id);
        continue;
      }
      job?.report((i - 1) / fileIds.length, `Analysiere ${f.name}`);
      try {
        const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, f.rootId)).get();
        if (!root || !isInside(root.path, f.path)) throw permissionError('Datei liegt nicht in einem freigegebenen Verzeichnis.');
        const real = await fsp.realpath(f.path);
        if (!isInside(await fsp.realpath(root.path), real)) throw permissionError('Symbolischer Link führt aus dem freigegebenen Verzeichnis heraus.');
        const st = await fsp.stat(real);
        const sha = await this.pool.run('hashFile', { path: real });
        const dup = this.isDup(sha);
        if (dup) {
          this.db
            .update(scanFiles)
            .set({ status: 'duplicate', duplicateOfDocumentId: dup, sha256: sha, size: st.size, mtimeMs: st.mtimeMs })
            .where(eq(scanFiles.id, id))
            .run();
          skipped.push(id);
          continue;
        }
        const folderLlmAllowed = root.llmAllowed && this.docs.folderLlmAllowedFor(real);
        let doc = f.documentId ? this.db.select().from(documents).where(eq(documents.id, f.documentId)).get() : undefined;
        if (!doc || doc.sha256 !== sha) {
          const rec = this.docs.insertDocument({
            originalName: f.name,
            ext: f.ext,
            size: st.size,
            sha256: sha,
            sourcePath: real,
            stagedPath: null,
            folderLlmAllowed,
          });
          doc = this.docs.getRow(rec.id);
        } else if (doc.folderLlmAllowed !== folderLlmAllowed) {
          this.db.update(documents).set({ folderLlmAllowed }).where(eq(documents.id, doc.id)).run();
        }
        const decision = this.privacy.evaluate({ path: real, ext: f.ext, rootLlmAllowed: root.llmAllowed });
        const allowLlm = decision.allowed && (mode === 'auto' || confirmLlm);
        const res = await this.docs.analyze(doc.id, { allowLlm });
        if (res.skipped) {
          // the document was archived in the meantime – nothing to propose
          skipped.push(id);
          continue;
        }
        const updated = this.docs.getRow(doc.id);
        this.db
          .update(scanFiles)
          .set({
            status: 'analyzed',
            documentId: doc.id,
            sha256: sha,
            size: st.size,
            mtimeMs: st.mtimeMs,
            llmStatus: res.usedLlm ? 'analyzed' : updated.llmStatus,
          })
          .where(eq(scanFiles.id, id))
          .run();
        analyzed.push(doc.id);
      } catch (err) {
        // analyze() has already set the document to `failed` (reprocessable from the inbox), so it is not stuck in `analyzing`
        this.ctx.logger.warn('scanner', 'Analyse fehlgeschlagen', { fileId: id, error: err });
        this.notifications.create({
          title: 'Dateianalyse fehlgeschlagen',
          description: `${f.name}: ${err instanceof Error ? err.message : String(err)}`,
          type: 'import_failed',
          priority: 'normal',
          dedupeKey: `analyze-failed:${id}`,
        });
        skipped.push(id);
      }
    }
    this.buildProposals(analyzed);
    this.ctx.events.changed('scanner', 'documents', 'status');
    return { analyzed, skipped };
  }

  private groupKey(p: DocumentProposal | null, category: string | null): { key: string; label: string; topic: string | null; project: string | null } {
    const project = p?.project ?? null;
    const topic = p?.topic ?? null;
    const name = project ?? topic ?? category?.split('/').slice(0, -1).join('/') ?? category ?? 'Unsortiert';
    return { key: `${project ? 'project' : topic ? 'topic' : 'category'}:${name}`.toLowerCase(), label: name, topic, project };
  }

  /** Zuordnungsvorschläge: gruppiert analysierte Dokumente nach Thema/Projekt und legt Insight, Aktion und Hinweis an. */
  buildProposals(docIds: string[]): void {
    const rows = docIds.length
      ? this.db
          .select()
          .from(documents)
          .where(and(inArray(documents.id, docIds), eq(documents.status, 'proposed')))
          .all()
      : [];
    const groups = new Map<string, { label: string; topic: string | null; project: string | null; rows: typeof rows }>();
    for (const r of rows) {
      const g = this.groupKey(r.proposal as DocumentProposal | null, r.categoryPath);
      const cur = groups.get(g.key) ?? { label: g.label, topic: g.topic, project: g.project, rows: [] };
      cur.rows.push(r);
      groups.set(g.key, cur);
    }
    for (const [key, g] of groups) {
      const known = (g.project && this.graph.findByName('project', g.project)) || (g.topic && this.graph.findByName('topic', g.topic)) || null;
      const decisions = g.rows.filter((r) => ((r.proposal as DocumentProposal | null)?.possibleDecisions.length ?? 0) > 0).length;
      const dups = g.rows.filter((r) => (r.proposal as DocumentProposal | null)?.duplicateOfDocumentId).length;
      const items = g.rows.map((r) => {
        const p = r.proposal as DocumentProposal | null;
        return {
          documentId: r.id,
          mode: 'copy' as const,
          categoryPath: p?.location.categoryPath ?? r.categoryPath ?? undefined,
          // null would mean "explicitly without topic/project"; a group without one only leaves it open.
          topic: g.topic ?? undefined,
          project: g.project ?? undefined,
        };
      });
      const label = known ? `${known.type === 'project' ? 'Projekt' : 'Thema'} „${known.name}“` : `„${g.label}“`;
      const n = g.rows.length;
      const proposal = {
        actionType: 'archive_documents' as const,
        label: `${n} Dokument(e) archivieren und zuordnen (${g.label})`,
        rationale: `${n} analysierte Datei(en) gehören vermutlich zu ${label}.`,
        confidence: Math.min(...g.rows.map((r) => r.confidence ?? 0.4)),
        affectedEntities: g.rows.map((r) => ({ type: 'document' as const, id: r.id, label: r.title })),
        requiredConfirmation: 'confirm' as const,
        proposedParameters: { items, approveNewCategories: [] },
      };
      const ids = g.rows.map((r) => r.id).sort();
      const dedupeKey = `scan-group:${key}:${ids.join(',').slice(0, 120)}`;
      this.insights.upsert({
        kind: known ? 'assignment' : 'archive_proposal',
        title: `${n} Dokument${n === 1 ? '' : 'e'} ${known ? 'gehören vermutlich zu' : 'passen zu'} ${label}`,
        explanation: `${g.rows.map((r) => `• ${r.title} → ${(r.proposal as DocumentProposal | null)?.location.categoryPath ?? r.categoryPath}`).join('\n')}${decisions ? `\n${decisions} enthalten mögliche Entscheidungen.` : ''}${dups ? `\n${dups} scheinen Duplikate zu sein.` : ''}`,
        confidence: proposal.confidence,
        affected: proposal.affectedEntities,
        sourceIds: ids,
        // proposed only if the insight is (still) open: no orphaned proposals when the group is analyzed again
        action: { proposal, label: 'Alle kopieren und archivieren' },
        dedupeKey,
      });
      this.notifications.create({
        title: `${n} Dokument${n === 1 ? '' : 'e'} ${known ? `zu ${label}` : 'bereit zur Archivierung'}`,
        description: `${n} davon gehören vermutlich zu ${label}${decisions ? `, ${decisions} enthalten mögliche Entscheidungen` : ''}${dups ? `, ${dups} scheinen Duplikate zu sein` : ''}.`,
        type: 'assignment_proposal',
        priority: known ? 'high' : 'normal',
        affectedEntityIds: ids,
        proposedActions: [
          { label: 'Prüfen', kind: 'navigate', target: '/scan/' },
          { label: 'Ablehnen', kind: 'ignore' },
        ],
        dedupeKey,
      });
    }
  }

  /** Vorschlagsgruppen für die Scan-Ansicht (noch nicht archivierte, analysierte Scan-Dokumente). */
  proposals(): ScanProposalGroup[] {
    const files = this.db
      .select()
      .from(scanFiles)
      .where(and(eq(scanFiles.status, 'analyzed')))
      .all();
    const ids = files.map((f) => f.documentId).filter((x): x is string => Boolean(x));
    if (ids.length === 0) return [];
    const rows = this.db
      .select()
      .from(documents)
      .where(and(inArray(documents.id, ids), eq(documents.status, 'proposed')))
      .all();
    const groups = new Map<string, ScanProposalGroup>();
    for (const r of rows) {
      const g = this.groupKey(r.proposal as DocumentProposal | null, r.categoryPath);
      const cur = groups.get(g.key) ?? { key: g.key, label: g.label, topic: g.topic, project: g.project, documentIds: [], confidence: 1 };
      cur.documentIds.push(r.id);
      cur.confidence = Math.min(cur.confidence, r.confidence ?? 0.4);
      groups.set(g.key, cur);
    }
    return [...groups.values()].sort((a, b) => b.documentIds.length - a.documentIds.length);
  }

  // ---------- Zeitsteuerung (nur bei laufender Anwendung) ----------
  applySettings(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const s = this.settings.get().scan;
    if (!s.enabled || this.listDirectories().length === 0) return;
    if (s.periodic) {
      const t = setInterval(() => {
        try {
          this.startScan(undefined, 'interval');
        } catch (err) {
          this.ctx.logger.warn('scanner', 'Periodischer Scan nicht gestartet', { error: err });
        }
      }, s.intervalMinutes * 60_000);
      t.unref?.();
      this.timers.push(t);
    }
  }

  startupScan(): void {
    const s = this.settings.get().scan;
    if (s.enabled && s.onStartup && this.listDirectories().length > 0) {
      try {
        this.startScan(undefined, 'startup');
      } catch (err) {
        this.ctx.logger.warn('scanner', 'Startscan nicht gestartet', { error: err });
      }
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  fileExists(p: string): boolean {
    return fs.existsSync(p);
  }
}
