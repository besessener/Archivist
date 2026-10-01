import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ArchiveItemRequest,
  ArchivePlan,
  ArchivePlanItem,
  ArchiveResult,
  DocumentProposal,
  VerifyReport,
} from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { AppError, fsError, permissionError, toErrorInfo } from '../util/errors';
import { nowIso } from '../util/ids';
import { sha256File } from '../util/hash';
import { assertRealInside, resolveInside, sanitizeCategoryPath, sanitizeFileName, uniquePath } from '../util/paths';
import type { WorkerPool } from '../workers/pool';
import type { ActionService } from './actions';
import type { AuditService } from './audit';
import type { CategoryService } from './categories';
import type { DocRow, DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { NotificationService } from './notifications';
import type { SettingsService } from './settings';
import type { UndoService } from './undo';

interface UndoData {
  documentId: string;
  mode: 'copy' | 'move' | 'index_only' | 'ignore';
  archiveRel: string | null;
  sha256: string;
  sourcePath: string | null;
  stagedPath: string | null;
  removedStaged: boolean;
  removedSource: boolean;
  before: Pick<DocRow, 'status' | 'archiveRelPath' | 'categoryPath' | 'topicId' | 'projectId' | 'archiveMode' | 'stagedPath' | 'archivedAt'>;
  relationIds: string[];
  afterUpdatedAt: string;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export interface ExecuteOptions {
  confirmed: boolean;
  approveNewCategories: string[];
  confirmMove: boolean;
  trigger?: string;
}

/**
 * Kontrollierte Dateiaktionen. Garantien:
 *  - nichts wird ohne `confirmed` ausgeführt,
 *  - Zieldateien werden nie überschrieben (COPYFILE_EXCL, automatische Umbenennung),
 *  - Kopien werden per Prüfsumme verifiziert, bevor Quellen entfernt werden,
 *  - Pfade bleiben innerhalb des Archivs (kein Traversal, kein Symlink-Ausbruch),
 *  - Undo prüft vorher, ob sich seitdem etwas geändert hat.
 */
export class ArchiveService {
  private actions!: ActionService;

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly docs: DocumentService,
    private readonly categories: CategoryService,
    private readonly graph: KnowledgeGraphService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly pool: WorkerPool,
    undo: UndoService,
  ) {
    undo.register('archive_file', { check: (d) => this.undoCheck(d as UndoData), run: (d) => this.undoRun(d as UndoData) });
  }

  wire(deps: { actions: ActionService }): void {
    this.actions = deps.actions;
  }

  private get db() {
    return this.ctx.database.db;
  }

  private get root() {
    return this.settings.get().archiveRoot;
  }

  createCategory(p: string, confirmed: boolean) {
    const c = this.categories.create(p, confirmed);
    this.audit.log({ action: 'category.create', actor: 'user', trigger: 'manual', confirmed, after: { path: c.path } });
    return c;
  }

  // ---------- Plan ----------
  private async planItem(req: ArchiveItemRequest): Promise<ArchivePlanItem & { _cat?: string; _name?: string; _targetDir?: string }> {
    const row = this.docs.getRow(req.documentId);
    const proposal = row.proposal as DocumentProposal | null;
    const base: ArchivePlanItem = {
      documentId: row.id,
      title: row.title,
      action: req.mode,
      sourcePath: row.stagedPath ?? row.sourcePath,
      targetPath: null,
      targetRelPath: null,
      renamed: false,
      willRemoveSource: false,
      duplicates: [],
      conflicts: [],
      newCategories: [],
      affected: [{ type: 'document', id: row.id, label: row.title }],
      rationale: proposal?.location.rationale ?? '',
      confidence: row.confidence,
      blocked: false,
    };
    if (row.status === 'archived') return { ...base, blocked: true, conflicts: ['Das Dokument ist bereits archiviert.'] };
    if (req.mode === 'ignore') return { ...base, sourcePath: row.sourcePath };

    const dupes = this.docs.findDuplicates(row.sha256, row.id).filter((d) => d.status === 'archived' || d.status === 'indexed_only');
    base.duplicates = dupes.map((d) => ({ documentId: d.id, title: d.title, archivePath: d.archiveRelPath ? path.join(this.root, ...d.archiveRelPath.split('/')) : null }));
    for (const t of [proposal?.topic, proposal?.project, req.topic, req.project]) {
      if (t) {
        const e = this.graph.findByName(t === proposal?.project || t === req.project ? 'project' : 'topic', t);
        if (e) base.affected.push({ type: e.type, id: e.id, label: e.name });
      }
    }

    let source: string;
    try {
      source = this.docs.readablePath(row);
    } catch {
      return { ...base, blocked: true, conflicts: ['Die Quelldatei ist nicht mehr vorhanden.'] };
    }
    base.sourcePath = source;
    if (req.mode === 'index_only') return base;

    let cat: string;
    try {
      cat = sanitizeCategoryPath(req.categoryPath ?? proposal?.location.categoryPath ?? row.categoryPath ?? '');
    } catch (err) {
      return { ...base, blocked: true, conflicts: [err instanceof AppError ? err.message : 'Ungültiger Zielordner.'] };
    }
    const ext = row.ext;
    let name = sanitizeFileName(req.fileName ?? proposal?.location.fileName ?? row.originalName);
    if (path.extname(name).slice(1).toLowerCase() !== ext) name = `${name}.${ext}`;
    const targetDir = resolveInside(this.root, cat);
    try {
      await assertRealInside(this.root, targetDir);
    } catch (err) {
      return { ...base, blocked: true, conflicts: [err instanceof AppError ? err.message : 'Zielpfad ungültig.'] };
    }
    const target = await uniquePath(targetDir, name);
    const collided = path.basename(target) !== name;
    const newMain = this.categories.needsApproval(cat);
    return {
      ...base,
      targetPath: target,
      targetRelPath: toPosix(path.relative(this.root, target)),
      renamed: collided || name !== row.originalName,
      willRemoveSource: req.mode === 'move' || Boolean(row.stagedPath && source === row.stagedPath),
      conflicts: collided ? [`Im Zielordner existiert bereits „${name}“ – die Datei wird als „${path.basename(target)}“ abgelegt (nichts wird überschrieben).`] : [],
      newCategories: newMain ? [newMain] : [],
      _cat: cat,
      _name: name,
      _targetDir: targetDir,
    };
  }

  async preview(items: ArchiveItemRequest[]): Promise<ArchivePlan> {
    const planned = await Promise.all(items.map((i) => this.planItem(i)));
    const plan = planned.map(({ _cat, _name, _targetDir, ...rest }) => (void _cat, void _name, void _targetDir, rest));
    const newCategories = [...new Set(plan.flatMap((p) => p.newCategories))];
    const moves = plan.filter((p) => p.action === 'move' && !p.blocked).length;
    return {
      items: plan,
      newCategories,
      requiresStrongConfirmation: moves > 0 || newCategories.length > 0,
      summary: `${plan.filter((p) => !p.blocked).length} von ${plan.length} Dateien bereit${moves ? `, ${moves} werden verschoben (Original wird entfernt)` : ''}${newCategories.length ? `, neue Hauptkategorie(n): ${newCategories.join(', ')}` : ''}.`,
    };
  }

  // ---------- Ausführung ----------
  private async copyExclusive(src: string, dir: string, fileName: string): Promise<string> {
    await fsp.mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dest = await uniquePath(dir, fileName);
      try {
        await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
        return dest;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new AppError('archive_conflict', 'Es konnte kein freier Zieldateiname gefunden werden.', { retryable: true });
  }

  async execute(items: ArchiveItemRequest[], opts: ExecuteOptions): Promise<ArchiveResult> {
    if (!opts.confirmed) throw permissionError('Dateiaktionen erfordern eine ausdrückliche Bestätigung des Benutzers.');
    const result: ArchiveResult = { items: [], success: 0, skipped: 0, failed: 0, conflicts: 0 };
    for (const req of items) {
      let outcome: ArchiveResult['items'][number];
      try {
        outcome = await this.executeOne(req, opts);
      } catch (err) {
        const info = toErrorInfo(err);
        this.ctx.logger.error('archive', 'Archivierung fehlgeschlagen', { documentId: req.documentId, error: err });
        this.audit.log({ action: `archive.${req.mode}`, actor: 'user', trigger: opts.trigger ?? 'manual', confirmed: true, entityIds: [req.documentId], success: false, error: `${info.message} ${info.details ?? ''}`.trim() });
        outcome = { documentId: req.documentId, outcome: 'failed', targetPath: null, message: info.message + (info.details ? ` (${info.details})` : ''), auditId: null };
        this.notifications.create({ title: 'Archivierung fehlgeschlagen', description: outcome.message, type: 'import_failed', priority: 'high', affectedEntityIds: [req.documentId] });
      }
      result.items.push(outcome);
      if (outcome.outcome === 'success') result.success += 1;
      else if (outcome.outcome === 'skipped') result.skipped += 1;
      else if (outcome.outcome === 'conflict') result.conflicts += 1;
      else result.failed += 1;
    }
    this.ctx.events.changed('documents', 'knowledge', 'audit', 'status');
    return result;
  }

  private async executeOne(req: ArchiveItemRequest, opts: ExecuteOptions): Promise<ArchiveResult['items'][number]> {
    const plan = await this.planItem(req);
    const row = this.docs.getRow(req.documentId);
    const trigger = opts.trigger ?? 'manual';
    if (plan.blocked) return { documentId: row.id, outcome: plan.conflicts.some((c) => c.includes('bereits archiviert')) ? 'skipped' : 'conflict', targetPath: null, message: plan.conflicts.join(' '), auditId: null };

    const proposal = row.proposal as DocumentProposal | null;
    const topicName = (req.topic !== undefined ? req.topic : proposal?.topic)?.trim() || null;
    const projectName = (req.project !== undefined ? req.project : proposal?.project)?.trim() || null;
    const before: UndoData['before'] = { status: row.status as never, archiveRelPath: row.archiveRelPath, categoryPath: row.categoryPath, topicId: row.topicId, projectId: row.projectId, archiveMode: row.archiveMode, stagedPath: row.stagedPath, archivedAt: row.archivedAt };

    // --- Ignorieren ---
    if (req.mode === 'ignore') {
      const updatedAt = nowIso();
      this.db.update(documents).set({ status: 'ignored', archiveMode: 'ignore', updatedAt }).where(eq(documents.id, row.id)).run();
      const auditId = this.audit.log({
        action: 'archive.ignore', actor: 'user', trigger, confirmed: true, entityIds: [row.id], paths: [row.sourcePath ?? ''].filter(Boolean),
        before: { status: row.status }, after: { status: 'ignored' },
        undo: { type: 'archive_file', data: { documentId: row.id, mode: 'ignore', archiveRel: null, sha256: row.sha256, sourcePath: row.sourcePath, stagedPath: row.stagedPath, removedStaged: false, removedSource: false, before, relationIds: [], afterUpdatedAt: updatedAt } satisfies UndoData },
      });
      return { documentId: row.id, outcome: 'success', targetPath: null, message: 'Ignoriert (keine Dateiaktion).', auditId };
    }

    // --- neue Hauptkategorie braucht ausdrückliche Bestätigung ---
    if (plan.newCategories.length > 0 && !plan.newCategories.every((c) => opts.approveNewCategories.some((a) => a.toLowerCase() === c.toLowerCase()))) {
      return { documentId: row.id, outcome: 'conflict', targetPath: null, message: `Neue Hauptkategorie „${plan.newCategories.join(', ')}“ wurde nicht bestätigt.`, auditId: null };
    }
    if (req.mode === 'move' && !opts.confirmMove) {
      return { documentId: row.id, outcome: 'skipped', targetPath: null, message: 'Verschieben erfordert eine zusätzliche Bestätigung („Original wird entfernt“).', auditId: null };
    }

    const source = plan.sourcePath!;
    const currentSha = await sha256File(source);
    if (currentSha !== row.sha256) {
      return { documentId: row.id, outcome: 'conflict', targetPath: null, message: 'Die Quelldatei hat sich seit der Analyse verändert. Bitte erneut analysieren.', auditId: null };
    }

    let targetAbs: string | null = null;
    let archiveRel: string | null = null;
    const relationIds: string[] = [];
    const cat = plan._cat ?? null;

    if (req.mode === 'index_only') {
      // keine Dateiaktion
    } else {
      targetAbs = await this.copyExclusive(source, plan._targetDir!, plan._name!);
      let verified = false;
      try {
        verified = (await sha256File(targetAbs)) === row.sha256;
      } catch {
        verified = false;
      }
      if (!verified) {
        await fsp.unlink(targetAbs).catch(() => undefined); // nur die soeben angelegte Kopie
        throw new AppError('filesystem_error', 'Die Prüfsumme der Archivkopie stimmt nicht überein; der Vorgang wurde zurückgenommen.', { retryable: true });
      }
      archiveRel = toPosix(path.relative(this.root, targetAbs));
    }

    // --- Datenbank + Wissensgraph in einer Transaktion ---
    const updatedAt = nowIso();
    try {
      this.ctx.database.transaction(() => {
        if (cat) this.categories.create(cat, true);
        const topic = topicName ? this.graph.ensureEntity('topic', topicName) : null;
        const project = projectName ? this.graph.ensureEntity('project', projectName) : null;
        this.db
          .update(documents)
          .set({
            status: req.mode === 'index_only' ? 'indexed_only' : 'archived',
            archiveRelPath: archiveRel,
            categoryPath: cat ?? row.categoryPath,
            archiveMode: req.mode,
            topicId: topic?.id ?? row.topicId,
            projectId: project?.id ?? row.projectId,
            archivedAt: updatedAt,
            updatedAt,
          })
          .where(eq(documents.id, row.id))
          .run();
        const keep = (r: { id: string } | null) => r && relationIds.push(r.id);
        if (topic) keep(this.graph.link(row.id, topic.id, 'relates_to', { confidence: row.confidence ?? 0.8, status: 'confirmed', sourceIds: [row.id] }));
        if (project) keep(this.graph.link(row.id, project.id, 'belongs_to', { confidence: row.confidence ?? 0.8, status: 'confirmed', sourceIds: [row.id] }));
        if (cat) keep(this.graph.link(row.id, this.graph.ensureEntity('category', cat).id, 'belongs_to', { confidence: 1, status: 'confirmed', sourceIds: [row.id] }));
        for (const person of (proposal?.persons ?? row.persons).slice(0, 12)) keep(this.graph.link(this.graph.ensureEntity('person', person).id, row.id, 'produced', { confidence: 0.5, status: 'proposed', sourceIds: [row.id] }));
        for (const tag of row.tags.slice(0, 8)) keep(this.graph.link(row.id, this.graph.ensureEntity('tag', tag).id, 'relates_to', { confidence: 0.6, status: 'confirmed', sourceIds: [row.id] }));
        if (proposal?.duplicateOfDocumentId) keep(this.graph.link(row.id, proposal.duplicateOfDocumentId, 'duplicate_of', { confidence: 0.8, status: 'proposed', sourceIds: [row.id] }));
      });
    } catch (err) {
      if (targetAbs) await fsp.unlink(targetAbs).catch(() => undefined); // keine halbfertige Dateioperation zurücklassen
      throw err;
    }

    // --- Quellen entfernen (erst nach erfolgreichem Commit; eigene Staging-Kopie bzw. bestätigtes Verschieben) ---
    let removedStaged = false;
    let removedSource = false;
    const warnings: string[] = [];
    if (req.mode !== 'index_only') {
      if (row.stagedPath && fs.existsSync(row.stagedPath)) {
        await fsp.unlink(row.stagedPath);
        removedStaged = true;
      }
      if (req.mode === 'move' && row.sourcePath && fs.existsSync(row.sourcePath)) {
        try {
          if ((await sha256File(row.sourcePath)) === row.sha256) {
            await fsp.unlink(row.sourcePath);
            removedSource = true;
          } else warnings.push('Das Original wurde verändert und deshalb nicht entfernt.');
        } catch (err) {
          warnings.push(`Das Original konnte nicht entfernt werden: ${(err as Error).message}`);
        }
      }
    }
    let finalUpdatedAt = updatedAt;
    if (removedStaged) {
      finalUpdatedAt = nowIso();
      this.db.update(documents).set({ stagedPath: null, updatedAt: finalUpdatedAt }).where(eq(documents.id, row.id)).run();
    }

    const undoData: UndoData = { documentId: row.id, mode: req.mode, archiveRel, sha256: row.sha256, sourcePath: row.sourcePath, stagedPath: row.stagedPath, removedStaged, removedSource, before, relationIds, afterUpdatedAt: finalUpdatedAt };
    const auditId = this.audit.log({
      action: `archive.${req.mode}`,
      actor: trigger === 'agent_action' ? 'agent' : 'user',
      trigger,
      confirmed: true,
      entityIds: [row.id],
      paths: [source, targetAbs ?? ''].filter(Boolean),
      before: { status: row.status, path: source },
      after: { status: req.mode === 'index_only' ? 'indexed_only' : 'archived', path: targetAbs, removedSource, removedStaged },
      undo: { type: 'archive_file', data: undoData },
    });

    await this.docs.indexDocument(row.id);
    this.ctx.events.emit('document:archived', { documentId: row.id, sourcePath: row.sourcePath });
    this.notifications.resolveByDedupePrefix(`classified:${row.id}`);
    this.proposeExtractedItems(row, proposal);
    return { documentId: row.id, outcome: 'success', targetPath: targetAbs, message: [req.mode === 'index_only' ? 'Nur indexiert.' : req.mode === 'move' ? 'Ins Archiv verschoben.' : 'Ins Archiv kopiert.', ...warnings].join(' '), auditId };
  }

  /** Vorschläge für in Dokumenten erkannte Entscheidungen/offene Punkte (Stufe 1: nur Vorschlag, keine Änderung). */
  private proposeExtractedItems(row: DocRow, proposal: DocumentProposal | null): void {
    if (!proposal) return;
    const topic = proposal.topic;
    const project = proposal.project;
    const mk = (kind: 'open' | 'decision') => {
      const list = kind === 'open' ? proposal.possibleOpenItems.slice(0, 3) : proposal.possibleDecisions.slice(0, 3);
      if (list.length === 0) return;
      const actions = list.map((it) =>
        kind === 'open'
          ? this.actions.propose({ actionType: 'create_open_item', label: `Offenen Punkt anlegen: ${(it as { title: string }).title}`, rationale: `Im Dokument „${row.title}“ erkannt.`, confidence: 0.6, affectedEntities: [{ type: 'document', id: row.id, label: row.title }], requiredConfirmation: 'confirm', proposedParameters: { title: (it as { title: string }).title, description: (it as { description?: string | null }).description ?? null, dueAt: (it as { dueAt?: string | null }).dueAt ?? null, sourceIds: [row.id], topic, project } })
          : this.actions.propose({ actionType: 'record_decision', label: `Entscheidung erfassen: ${(it as { title: string }).title}`, rationale: `Im Dokument „${row.title}“ erkannt.`, confidence: 0.55, affectedEntities: [{ type: 'document', id: row.id, label: row.title }], requiredConfirmation: 'confirm', proposedParameters: { title: (it as { title: string }).title, decisionText: (it as { decisionText: string }).decisionText, decidedAt: (it as { decidedAt?: string | null }).decidedAt ?? null, participants: proposal.persons.slice(0, 5), topic, project, sourceIds: [row.id] } }),
      );
      this.notifications.create({
        title: kind === 'open' ? `Dokument enthält ${list.length} mögliche offene Punkte` : `Dokument enthält ${list.length} mögliche Entscheidung(en)`,
        description: `„${row.title}“ – bitte prüfen und bei Bedarf übernehmen.`,
        type: kind === 'open' ? 'file_has_open_item' : 'file_has_decision',
        priority: 'normal',
        affectedEntityIds: [row.id],
        proposedActions: actions.map((a) => ({ label: a.label.slice(0, 60), kind: 'confirm_action' as const, target: a.id })),
        dedupeKey: `extracted:${kind}:${row.id}`,
      });
    };
    mk('open');
    mk('decision');
  }

  // ---------- Undo ----------
  private async undoCheck(d: UndoData): Promise<string[]> {
    const conflicts: string[] = [];
    const row = this.db.select().from(documents).where(eq(documents.id, d.documentId)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    if (row.updatedAt !== d.afterUpdatedAt) conflicts.push('Das Dokument wurde seit der Archivierung verändert.');
    if (d.mode === 'copy' || d.mode === 'move') {
      const abs = d.archiveRel ? path.join(this.root, ...d.archiveRel.split('/')) : null;
      if (!abs || !fs.existsSync(abs)) conflicts.push('Die archivierte Datei fehlt am erwarteten Ort.');
      else if ((await sha256File(abs)) !== d.sha256) conflicts.push('Die archivierte Datei wurde seit der Archivierung verändert.');
      if (d.removedStaged && d.stagedPath && fs.existsSync(d.stagedPath)) conflicts.push(`Am Eingangsort existiert bereits eine Datei: ${d.stagedPath}`);
      if (d.removedSource && d.sourcePath) {
        if (fs.existsSync(d.sourcePath)) conflicts.push(`Am ursprünglichen Ort existiert bereits eine Datei: ${d.sourcePath}`);
        else if (!fs.existsSync(path.dirname(d.sourcePath))) conflicts.push(`Der ursprüngliche Ordner existiert nicht mehr: ${path.dirname(d.sourcePath)}`);
      }
      const hasOther = (d.sourcePath && !d.removedSource && fs.existsSync(d.sourcePath)) || d.removedStaged || d.removedSource;
      if (!hasOther) conflicts.push('Es gibt keine weitere Kopie der Datei – Undo würde die einzige Kopie löschen.');
    }
    return conflicts;
  }

  private async undoRun(d: UndoData): Promise<string> {
    const abs = d.archiveRel ? path.join(this.root, ...d.archiveRel.split('/')) : null;
    if ((d.mode === 'copy' || d.mode === 'move') && abs) {
      const restoreTo = async (dest: string) => {
        await fsp.copyFile(abs, dest, fs.constants.COPYFILE_EXCL);
        if ((await sha256File(dest)) !== d.sha256) {
          await fsp.unlink(dest).catch(() => undefined);
          throw fsError('Wiederherstellung konnte nicht verifiziert werden.');
        }
      };
      if (d.removedStaged && d.stagedPath) await restoreTo(d.stagedPath);
      if (d.removedSource && d.sourcePath) await restoreTo(d.sourcePath);
      await fsp.unlink(abs);
      // leere Zwischenordner im Archiv wieder entfernen (nie nicht-leere)
      let dir = path.dirname(abs);
      while (dir !== this.root && dir.startsWith(this.root)) {
        try {
          await fsp.rmdir(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
    this.ctx.database.transaction(() => {
      this.db
        .update(documents)
        .set({ ...d.before, stagedPath: d.removedStaged ? d.stagedPath : d.before.stagedPath, updatedAt: nowIso() })
        .where(eq(documents.id, d.documentId))
        .run();
      for (const rid of d.relationIds) this.graph.deleteRelation(rid);
    });
    await this.docs.indexDocument(d.documentId);
    this.ctx.events.changed('documents', 'knowledge', 'status');
    return d.mode === 'ignore' ? 'Ignorieren rückgängig gemacht.' : d.mode === 'index_only' ? 'Indexierung rückgängig gemacht.' : 'Archivierung rückgängig gemacht; die Datei liegt wieder am ursprünglichen Ort.';
  }

  // ---------- Archivzustand ----------
  /** Vergleicht Datenbank- und Dateisystemzustand des Archivs. */
  async verify(): Promise<VerifyReport> {
    const rows = this.db.select().from(documents).where(inArray(documents.status, ['archived'])).all();
    const report: VerifyReport = { checkedDocuments: rows.length, missingFiles: [], changedFiles: [], untrackedFiles: [], ok: true };
    const known = new Set<string>();
    for (const r of rows) {
      if (!r.archiveRelPath) continue;
      const abs = path.join(this.root, ...r.archiveRelPath.split('/'));
      known.add(path.resolve(abs));
      if (!fs.existsSync(abs)) report.missingFiles.push({ documentId: r.id, title: r.title, path: abs });
      else if ((await this.pool.run('hashFile', { path: abs })) !== r.sha256) report.changedFiles.push({ documentId: r.id, title: r.title, path: abs });
    }
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && !known.has(path.resolve(full))) report.untrackedFiles.push(full);
      }
    };
    await walk(this.root);
    report.ok = report.missingFiles.length === 0 && report.changedFiles.length === 0;
    return report;
  }
}
