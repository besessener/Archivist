import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveItemRequest, ArchivePlan, ArchivePlanItem, ArchiveResult, DocumentProposal, VerifyReport } from '@archivist/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, relations } from '../db/schema';
import { AppError, fsError, permissionError, toErrorInfo } from '../util/errors';
import { nowIso } from '../util/ids';
import { normalizeName, truncate } from '../util/text';
import { sha256File } from '../util/hash';
import { assertRealInside, isInside, resolveInside, sanitizeCategoryPath, sanitizeFileName, uniquePath } from '../util/paths';
import type { WorkerPool } from '../workers/pool';
import type { ActionService } from './actions';
import type { AuditService } from './audit';
import type { CategoryService } from './categories';
import type { DocRow, DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { PersonService } from './persons';
import type { NotificationService } from './notifications';
import { matchOpenItems, type OpenItemService } from './open-items';
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
  before: Pick<DocRow, 'status' | 'archiveRelPath' | 'categoryPath' | 'topicId' | 'projectId' | 'archiveMode' | 'stagedPath' | 'archivedAt' | 'persons'>;
  relationIds: string[];
  afterUpdatedAt: string;
}

type RelationRow = typeof relations.$inferSelect;

interface RelocateUndoData {
  documentId: string;
  fromRel: string;
  toRel: string;
  sha256: string;
  beforeCategoryPath: string | null;
  /** updatedAt before relocating; undo restores it so that the archiving itself stays undoable. Missing in old entries. */
  beforeUpdatedAt?: string;
  afterUpdatedAt: string;
  /** Beziehung zur neuen Kategorie, falls sie durch das Umlagern entstand (wird bei Undo wieder entfernt). */
  addedRelationId: string | null;
  /** Legacy entries only: category whose relation was deleted; undo re-links it as confirmed. */
  removedCategory?: string | null;
  /** Category relations deleted by relocating, exactly as they were (undo inserts them again with the same id). */
  relationsRemoved?: RelationRow[];
  /** Category relations whose status relocating changed to confirmed, exactly as they were before. */
  relationsChanged?: RelationRow[];
}

/** Wunsch: ein bereits archiviertes Dokument in einen anderen Archivordner verschieben. */
export interface RelocateRequest {
  documentId: string;
  categoryPath: string;
}

export interface RelocatePlanItem {
  documentId: string;
  title: string;
  fromRelPath: string | null;
  toRelPath: string | null;
  /** Zielordner (relativ zum Archiv), wie er nach der Bereinigung lautet. */
  categoryPath: string | null;
  renamed: boolean;
  /** liegt schon im Zielordner */
  unchanged: boolean;
  blocked: boolean;
  conflicts: string[];
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/**
 * Topic/project the user chose: an omitted field falls back to the proposal,
 * an explicit `null` or empty string means "without topic/project".
 */
function assignmentNames(req: ArchiveItemRequest, proposal: DocumentProposal | null): { topicName: string | null; projectName: string | null } {
  return {
    topicName: (req.topic !== undefined ? req.topic : proposal?.topic)?.trim() || null,
    projectName: (req.project !== undefined ? req.project : proposal?.project)?.trim() || null,
  };
}

/** True when `p` is a readable file whose content has the given checksum. */
async function hasChecksum(p: string, sha256: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile() && (await sha256File(p)) === sha256;
  } catch {
    return false;
  }
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/** User-facing note for a file that could not be cleaned up and is still lying around. */
const leftoverNote = (what: string, p: string) => `${what} liegt noch unter „${p}“ und muss von Hand entfernt werden.`;

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
  private openItems!: OpenItemService;

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly docs: DocumentService,
    private readonly categories: CategoryService,
    private readonly graph: KnowledgeGraphService,
    private readonly persons: PersonService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly pool: WorkerPool,
    undo: UndoService,
  ) {
    undo.register('archive_file', { check: (d) => this.undoCheck(d as UndoData), run: (d) => this.undoRun(d as UndoData) });
    undo.register('archive_relocate', { check: (d) => this.relocateUndoCheck(d as RelocateUndoData), run: (d) => this.relocateUndoRun(d as RelocateUndoData) });
  }

  wire(deps: { actions: ActionService; openItems: OpenItemService }): void {
    this.actions = deps.actions;
    this.openItems = deps.openItems;
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
      removesInboxCopy: false,
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
    if (row.status === 'quarantined')
      return { ...base, blocked: true, conflicts: ['Die Datei liegt in Quarantäne. Bitte zuerst in der Inbox „Trotzdem importieren“ wählen.'] };

    const dupes = this.docs.findDuplicates(row.sha256, row.id).filter((d) => d.status === 'archived' || d.status === 'indexed_only');
    base.duplicates = dupes.map((d) => ({
      documentId: d.id,
      title: d.title,
      archivePath: d.archiveRelPath ? path.join(this.root, ...d.archiveRelPath.split('/')) : null,
    }));
    const assigned = assignmentNames(req, proposal);
    for (const [type, name] of [
      ['topic', assigned.topicName],
      ['project', assigned.projectName],
    ] as const) {
      const e = name ? this.graph.findByName(type, name) : null;
      if (e) base.affected.push({ type: e.type, id: e.id, label: e.name });
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
      // Only the user's original counts as "removed"; Archivist's own inbox copy is merely cleaned up.
      willRemoveSource: req.mode === 'move' && Boolean(row.sourcePath && row.sourcePath !== row.stagedPath && fs.existsSync(row.sourcePath)),
      removesInboxCopy: Boolean(row.stagedPath && fs.existsSync(row.stagedPath)),
      conflicts: collided
        ? [`Im Zielordner existiert bereits „${name}“ – die Datei wird als „${path.basename(target)}“ abgelegt (nichts wird überschrieben).`]
        : [],
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
  /**
   * Removes a file this service has just created (partial copy, unverified copy, extra hardlink).
   * Returns false when the file is still there afterwards; the caller must then report it to the user.
   */
  private async removeCreated(p: string): Promise<boolean> {
    try {
      await fsp.unlink(p);
      return true;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return true;
      this.ctx.logger.error('archive', 'Soeben angelegte Datei konnte nicht wieder entfernt werden', { path: p, error: err });
      return false;
    }
  }

  /**
   * Copies `src` into `dir` without overwriting anything. A copy that fails halfway (e.g. disk full) leaves no partial
   * file behind; if that cleanup fails as well, the error says where the partial copy is.
   */
  private async copyExclusive(src: string, dir: string, fileName: string): Promise<string> {
    await fsp.mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dest = await uniquePath(dir, fileName);
      try {
        await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
        return dest;
      } catch (err) {
        if (errCode(err) === 'EEXIST') continue; // someone else's file: never touch it, try the next free name
        const what = `Die Datei konnte nicht kopiert werden${errCode(err) ? ` (${errCode(err)})` : ''}.`;
        if (await this.removeCreated(dest)) throw fsError(`${what} Es wurde nichts verändert.`, err);
        throw fsError(`${what} ${leftoverNote('Eine unvollständige Kopie', dest)}`, err);
      }
    }
    throw new AppError('archive_conflict', 'Es konnte kein freier Zieldateiname gefunden werden.', { retryable: true });
  }

  async execute(items: ArchiveItemRequest[], opts: ExecuteOptions): Promise<ArchiveResult> {
    if (!opts.confirmed) throw permissionError('Dateiaktionen erfordern eine ausdrückliche Bestätigung des Benutzers.');
    await this.cleanupInbox();
    const result: ArchiveResult = { items: [], success: 0, skipped: 0, failed: 0, conflicts: 0 };
    for (const req of items) {
      let outcome: ArchiveResult['items'][number];
      try {
        outcome = await this.executeOne(req, opts);
      } catch (err) {
        const info = toErrorInfo(err);
        this.ctx.logger.error('archive', 'Archivierung fehlgeschlagen', { documentId: req.documentId, error: err });
        this.audit.log({
          action: `archive.${req.mode}`,
          actor: 'user',
          trigger: opts.trigger ?? 'manual',
          confirmed: true,
          entityIds: [req.documentId],
          success: false,
          error: `${info.message} ${info.details ?? ''}`.trim(),
        });
        outcome = {
          documentId: req.documentId,
          outcome: 'failed',
          targetPath: null,
          message: info.message + (info.details ? ` (${info.details})` : ''),
          auditId: null,
        };
        this.notifications.create({
          title: 'Archivierung fehlgeschlagen',
          description: outcome.message,
          type: 'import_failed',
          priority: 'high',
          affectedEntityIds: [req.documentId],
        });
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
    if (plan.blocked)
      return {
        documentId: row.id,
        outcome: plan.conflicts.some((c) => c.includes('bereits archiviert')) ? 'skipped' : 'conflict',
        targetPath: null,
        message: plan.conflicts.join(' '),
        auditId: null,
      };

    const proposal = row.proposal as DocumentProposal | null;
    const { topicName, projectName } = assignmentNames(req, proposal);
    const before: UndoData['before'] = {
      status: row.status,
      archiveRelPath: row.archiveRelPath,
      categoryPath: row.categoryPath,
      topicId: row.topicId,
      projectId: row.projectId,
      archiveMode: row.archiveMode,
      stagedPath: row.stagedPath,
      archivedAt: row.archivedAt,
      persons: row.persons,
    };

    // --- Ignorieren ---
    if (req.mode === 'ignore') {
      const updatedAt = nowIso();
      this.db.update(documents).set({ status: 'ignored', archiveMode: 'ignore', updatedAt }).where(eq(documents.id, row.id)).run();
      const auditId = this.audit.log({
        action: 'archive.ignore',
        actor: 'user',
        trigger,
        confirmed: true,
        entityIds: [row.id],
        paths: [row.sourcePath ?? ''].filter(Boolean),
        before: { status: row.status },
        after: { status: 'ignored' },
        undo: {
          type: 'archive_file',
          data: {
            documentId: row.id,
            mode: 'ignore',
            archiveRel: null,
            sha256: row.sha256,
            sourcePath: row.sourcePath,
            stagedPath: row.stagedPath,
            removedStaged: false,
            removedSource: false,
            before,
            relationIds: [],
            afterUpdatedAt: updatedAt,
          } satisfies UndoData,
        },
      });
      return { documentId: row.id, outcome: 'success', targetPath: null, message: 'Ignoriert (keine Dateiaktion).', auditId };
    }

    // --- neue Hauptkategorie braucht ausdrückliche Bestätigung ---
    if (plan.newCategories.length > 0 && !plan.newCategories.every((c) => opts.approveNewCategories.some((a) => a.toLowerCase() === c.toLowerCase()))) {
      return {
        documentId: row.id,
        outcome: 'conflict',
        targetPath: null,
        message: `Neue Hauptkategorie „${plan.newCategories.join(', ')}“ wurde nicht bestätigt.`,
        auditId: null,
      };
    }
    if (req.mode === 'move' && !opts.confirmMove) {
      return {
        documentId: row.id,
        outcome: 'skipped',
        targetPath: null,
        message: 'Verschieben erfordert eine zusätzliche Bestätigung („Original wird entfernt“).',
        auditId: null,
      };
    }

    const source = plan.sourcePath!;
    const currentSha = await sha256File(source);
    if (currentSha !== row.sha256) {
      return {
        documentId: row.id,
        outcome: 'conflict',
        targetPath: null,
        message: 'Die Quelldatei hat sich seit der Analyse verändert. Bitte erneut analysieren.',
        auditId: null,
      };
    }

    let targetAbs: string | null = null;
    let archiveRel: string | null = null;
    const relationIds: string[] = [];
    const cat = plan._cat ?? null;

    if (req.mode === 'index_only') {
      // keine Dateiaktion
    } else {
      targetAbs = await this.copyExclusive(source, plan._targetDir!, plan._name!);
      let verified: boolean;
      try {
        verified = (await sha256File(targetAbs)) === row.sha256;
      } catch {
        verified = false;
      }
      if (!verified) {
        // only the copy just created
        const message = (await this.removeCreated(targetAbs))
          ? 'Die Prüfsumme der Archivkopie stimmt nicht überein; der Vorgang wurde zurückgenommen.'
          : `Die Prüfsumme der Archivkopie stimmt nicht überein. ${leftoverNote('Die fehlerhafte Kopie', targetAbs)}`;
        throw new AppError('filesystem_error', message, { retryable: true });
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
        // persons: the first 12 mentions become persons, the stored list uses canonical names
        const mentioned = proposal?.persons ?? row.persons;
        const people = this.persons.resolveNames(mentioned.slice(0, 12), { context: 'document' });
        const others = this.persons.resolveNames(mentioned.slice(12), { context: 'document', create: false }).names;
        const known = new Set(people.names.map(normalizeName));
        this.db
          .update(documents)
          .set({
            status: req.mode === 'index_only' ? 'indexed_only' : 'archived',
            persons: [...people.names, ...others.filter((n) => !known.has(normalizeName(n)))],
            archiveRelPath: archiveRel,
            categoryPath: cat ?? row.categoryPath,
            archiveMode: req.mode,
            // An explicitly emptied field means "without topic/project" and clears an earlier assignment.
            topicId: topic ? topic.id : req.topic !== undefined ? null : row.topicId,
            projectId: project ? project.id : req.project !== undefined ? null : row.projectId,
            archivedAt: updatedAt,
            updatedAt,
          })
          .where(eq(documents.id, row.id))
          .run();
        const keep = (r: { id: string } | null) => r && relationIds.push(r.id);
        if (topic) keep(this.graph.link(row.id, topic.id, 'relates_to', { confidence: row.confidence ?? 0.8, status: 'confirmed', sourceIds: [row.id] }));
        if (project) keep(this.graph.link(row.id, project.id, 'belongs_to', { confidence: row.confidence ?? 0.8, status: 'confirmed', sourceIds: [row.id] }));
        if (cat)
          keep(this.graph.link(row.id, this.graph.ensureEntity('category', cat).id, 'belongs_to', { confidence: 1, status: 'confirmed', sourceIds: [row.id] }));
        for (const person of people.entities)
          keep(this.graph.link(person.id, row.id, 'produced', { confidence: 0.5, status: 'proposed', sourceIds: [row.id] }));
        for (const tag of row.tags.slice(0, 8))
          keep(this.graph.link(row.id, this.graph.ensureEntity('tag', tag).id, 'relates_to', { confidence: 0.6, status: 'confirmed', sourceIds: [row.id] }));
        if (proposal?.duplicateOfDocumentId)
          keep(this.graph.link(row.id, proposal.duplicateOfDocumentId, 'duplicate_of', { confidence: 0.8, status: 'proposed', sourceIds: [row.id] }));
      });
    } catch (err) {
      // keine halbfertige Dateioperation zurücklassen
      if (targetAbs && !(await this.removeCreated(targetAbs))) {
        const info = toErrorInfo(err);
        throw new AppError(info.category, `${info.message} ${leftoverNote('Die bereits angelegte Archivkopie', targetAbs)}`, {
          details: info.details,
          cause: err,
        });
      }
      throw err;
    }

    // --- Quellen entfernen (erst nach erfolgreichem Commit; eigene Staging-Kopie bzw. bestätigtes Verschieben) ---
    let removedStaged = false;
    let removedSource = false;
    const warnings: string[] = [];
    if (req.mode !== 'index_only') {
      if (row.stagedPath && fs.existsSync(row.stagedPath)) {
        try {
          await fsp.unlink(row.stagedPath);
          removedStaged = true;
        } catch (err) {
          if (errCode(err) === 'ENOENT')
            removedStaged = true; // already gone (e.g. cleaned up concurrently)
          else {
            // The archive copy is verified and committed; a locked inbox copy (EBUSY/EPERM on Windows: open in a viewer,
            // held by a virus scanner) must not turn that into a failure. The row keeps its stagedPath, which marks the
            // copy for cleanupInbox().
            this.ctx.logger.warn('archive', 'Kopie im Eingang konnte nach dem Archivieren nicht entfernt werden', { documentId: row.id, error: err });
            warnings.push('Die Kopie im Eingang konnte noch nicht entfernt werden (z. B. weil sie gerade geöffnet ist); sie wird später automatisch entfernt.');
          }
        }
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

    const undoData: UndoData = {
      documentId: row.id,
      mode: req.mode,
      archiveRel,
      sha256: row.sha256,
      sourcePath: row.sourcePath,
      stagedPath: row.stagedPath,
      removedStaged,
      removedSource,
      before,
      relationIds,
      afterUpdatedAt: finalUpdatedAt,
    };
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

    // From here on the archiving is committed and undoable: follow-up steps may only add warnings.
    await this.reindexAfterCommit(row.id, warnings);
    this.ctx.events.emit('document:archived', { documentId: row.id, sourcePath: row.sourcePath });
    this.notifications.resolveByDedupePrefix(`classified:${row.id}`);
    try {
      this.proposeExtractedItems(row, proposal);
    } catch (err) {
      this.ctx.logger.error('archive', 'Vorschläge aus dem Dokument konnten nicht angelegt werden', { documentId: row.id, error: err });
    }
    return {
      documentId: row.id,
      outcome: 'success',
      targetPath: targetAbs,
      message: [req.mode === 'index_only' ? 'Nur indexiert.' : req.mode === 'move' ? 'Ins Archiv verschoben.' : 'Ins Archiv kopiert.', ...warnings].join(' '),
      auditId,
    };
  }

  /** Updates the search index after a committed file operation; a failure only becomes a warning. */
  private async reindexAfterCommit(documentId: string, warnings: string[]): Promise<void> {
    try {
      await this.docs.indexDocument(documentId);
    } catch (err) {
      this.ctx.logger.error('archive', 'Suchindex konnte nicht aktualisiert werden', { documentId, error: err });
      warnings.push('Der Suchindex konnte nicht aktualisiert werden.');
    }
  }

  /**
   * Removes inbox copies whose removal failed right after archiving (e.g. the file was open in a viewer).
   * Such documents are archived but still carry a stagedPath. A copy is only removed when it lies inside the inbox,
   * is unchanged and the archived file is intact; otherwise it stays. Never throws.
   * @returns number of documents whose pending inbox copy was cleaned up
   */
  async cleanupInbox(): Promise<number> {
    let cleaned = 0;
    try {
      const pending = this.db
        .select()
        .from(documents)
        .where(and(eq(documents.status, 'archived'), isNotNull(documents.stagedPath)))
        .all();
      for (const r of pending) {
        const staged = r.stagedPath!;
        if (!r.archiveRelPath || !isInside(this.ctx.paths.inbox, staged)) continue;
        if (!(await hasChecksum(path.join(this.root, ...r.archiveRelPath.split('/')), r.sha256))) continue; // keep the only intact copy
        if (fs.existsSync(staged)) {
          if (!(await hasChecksum(staged, r.sha256))) continue;
          if (!(await this.removeCreated(staged))) continue; // still locked: next attempt later
        }
        // updatedAt stays: this completes the archiving itself, so its undo must remain possible
        this.db.update(documents).set({ stagedPath: null }).where(eq(documents.id, r.id)).run();
        cleaned += 1;
      }
    } catch (err) {
      this.ctx.logger.error('archive', 'Aufräumen des Eingangs fehlgeschlagen', { error: err });
    }
    if (cleaned > 0) {
      this.ctx.logger.info('archive', 'Vorgemerkte Kopien im Eingang entfernt', { count: cleaned });
      this.ctx.events.changed('documents');
    }
    return cleaned;
  }

  /**
   * Vorschläge für in Dokumenten erkannte Entscheidungen/offene Punkte (Stufe 1: nur Vorschlag, keine Änderung).
   * Offene Punkte werden vorher gegen die aktiven abgeglichen: Bei einem Treffer wird der bestehende Punkt um das
   * Dokument als Quelle ergänzt statt doppelt angelegt.
   */
  private proposeExtractedItems(row: DocRow, proposal: DocumentProposal | null): void {
    if (!proposal) return;
    const topic = proposal.topic;
    const project = proposal.project;
    const docRef = { type: 'document' as const, id: row.id, label: row.title };
    const rationale = `Im Dokument „${row.title}“ erkannt.`;
    const active = proposal.possibleOpenItems.length ? this.openItems.list({ onlyActive: true }) : [];
    const openActions = proposal.possibleOpenItems.slice(0, 3).flatMap((it) => {
      const m = matchOpenItems(it.title, active, { threshold: 0.75 });
      if (m.status === 'match') {
        // Dokument ist bereits Quelle (z. B. erneut archiviert) – nichts vorzuschlagen
        if (m.item.sourceIds.includes(row.id)) return [];
        return [
          this.actions.propose({
            actionType: 'add_open_item_source',
            label: `Punkt „${truncate(m.item.title, 60)}“ um Quelle ergänzen`,
            rationale: `${rationale} Der Punkt ist bereits erfasst.`,
            confidence: 0.6,
            affectedEntities: [{ type: 'task', id: m.item.id, label: m.item.title }, docRef],
            requiredConfirmation: 'confirm',
            proposedParameters: {
              openItemId: m.item.id,
              documentId: row.id,
              description: it.description ?? null,
              dueAt: it.dueAt ?? null,
              responsible: it.responsible ?? null,
            },
          }),
        ];
      }
      return [
        this.actions.propose({
          actionType: 'create_open_item',
          label: `Offenen Punkt anlegen: ${it.title}`,
          rationale,
          confidence: 0.6,
          affectedEntities: [docRef],
          requiredConfirmation: 'confirm',
          proposedParameters: {
            title: it.title,
            description: it.description ?? null,
            dueAt: it.dueAt ?? null,
            responsible: it.responsible ?? null,
            sourceIds: [row.id],
            topic,
            project,
          },
        }),
      ];
    });
    const decisionActions = proposal.possibleDecisions.slice(0, 3).map((it) =>
      this.actions.propose({
        actionType: 'record_decision',
        label: `Entscheidung erfassen: ${it.title}`,
        rationale,
        confidence: 0.55,
        affectedEntities: [docRef],
        requiredConfirmation: 'confirm',
        proposedParameters: {
          title: it.title,
          decisionText: it.decisionText,
          decidedAt: it.decidedAt ?? null,
          participants: proposal.persons.slice(0, 5),
          topic,
          project,
          sourceIds: [row.id],
        },
      }),
    );
    const notify = (kind: 'open' | 'decision', actions: Array<{ id: string; label: string }>) => {
      if (actions.length === 0) return;
      this.notifications.create({
        title: kind === 'open' ? `Dokument enthält ${actions.length} mögliche offene Punkte` : `Dokument enthält ${actions.length} mögliche Entscheidung(en)`,
        description: `„${row.title}“ – bitte prüfen und bei Bedarf übernehmen.`,
        type: kind === 'open' ? 'file_has_open_item' : 'file_has_decision',
        priority: 'normal',
        affectedEntityIds: [row.id],
        proposedActions: actions.map((a) => ({ label: a.label.slice(0, 60), kind: 'confirm_action' as const, target: a.id })),
        dedupeKey: `extracted:${kind}:${row.id}`,
      });
    };
    notify('open', openActions);
    notify('decision', decisionActions);
  }

  // ---------- Umlagern innerhalb des Archivs ----------
  private sameDir(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  private async planRelocate(req: RelocateRequest): Promise<RelocatePlanItem & { _src?: string; _dir?: string; _name?: string; _cat?: string }> {
    const row = this.docs.getRow(req.documentId);
    const base: RelocatePlanItem = {
      documentId: row.id,
      title: row.title,
      fromRelPath: row.archiveRelPath,
      toRelPath: null,
      categoryPath: null,
      renamed: false,
      unchanged: false,
      blocked: false,
      conflicts: [],
    };
    const block = (message: string) => ({ ...base, blocked: true, conflicts: [message] });
    if (row.status !== 'archived' || !row.archiveRelPath || row.archiveMode === 'index_only')
      return block('Nur archivierte Dokumente mit einer Datei im Archiv lassen sich umlagern.');
    let cat: string;
    try {
      cat = sanitizeCategoryPath(req.categoryPath);
    } catch (err) {
      return block(err instanceof AppError ? err.message : 'Ungültiger Zielordner.');
    }
    const main = this.categories.needsApproval(cat);
    if (main) return block(`Die Hauptkategorie „${main}“ gibt es noch nicht. Neue Hauptkategorien müssen vorher ausdrücklich angelegt werden.`);
    let src: string;
    let targetDir: string;
    try {
      src = resolveInside(this.root, row.archiveRelPath);
      targetDir = resolveInside(this.root, cat);
      await assertRealInside(this.root, src);
      await assertRealInside(this.root, targetDir);
    } catch (err) {
      return block(err instanceof AppError ? err.message : 'Pfad ungültig.');
    }
    if (!fs.existsSync(src)) return block('Die Datei fehlt am erwarteten Ort im Archiv.');
    const withCat = { ...base, categoryPath: cat };
    if (this.sameDir(path.dirname(src), targetDir)) return { ...withCat, unchanged: true, toRelPath: row.archiveRelPath };
    const name = path.basename(src);
    const target = await uniquePath(targetDir, name);
    const collided = path.basename(target) !== name;
    return {
      ...withCat,
      toRelPath: toPosix(path.relative(this.root, target)),
      renamed: collided,
      conflicts: collided
        ? [`Im Zielordner existiert bereits „${name}“ – die Datei wird als „${path.basename(target)}“ abgelegt (nichts wird überschrieben).`]
        : [],
      _src: src,
      _dir: targetDir,
      _name: name,
      _cat: cat,
    };
  }

  /** Vorschau (ändert nichts): was würde beim Umlagern passieren? */
  async previewRelocate(items: RelocateRequest[]): Promise<RelocatePlanItem[]> {
    const planned = await Promise.all(items.map((i) => this.planRelocate(i)));
    return planned.map(({ _src, _dir, _name, _cat, ...rest }) => (void _src, void _dir, void _name, void _cat, rest));
  }

  /**
   * Legt eine zweite, verifizierte Fassung von `src` im Ordner `dir` unter `name` ab, ohne etwas zu überschreiben.
   * Bevorzugt ein Hardlink (atomar, schlägt bei vorhandenem Ziel fehl); wo das nicht geht, Kopie mit Prüfsumme.
   * On failure nothing new is left behind, or the error names the leftover partial copy.
   */
  private async placeExclusive(src: string, dir: string, name: string, sha256: string, exactName: boolean): Promise<{ dest: string; linked: boolean }> {
    await fsp.mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dest = exactName ? path.join(dir, name) : await uniquePath(dir, name);
      const taken = () => {
        if (exactName) throw new AppError('archive_conflict', `Am Zielort existiert bereits eine Datei: ${dest}`);
      };
      try {
        await fsp.link(src, dest);
        return { dest, linked: true };
      } catch (err) {
        if (errCode(err) === 'EEXIST') {
          taken();
          continue;
        }
      }
      // Dateisystem ohne Hardlinks (oder anderes Laufwerk): Kopie mit Prüfsumme
      let verified: boolean;
      try {
        await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
        verified = await hasChecksum(dest, sha256);
      } catch (err) {
        if (errCode(err) === 'EEXIST') {
          taken();
          continue;
        }
        const what = `Die Datei konnte nicht kopiert werden${errCode(err) ? ` (${errCode(err)})` : ''}.`;
        if (await this.removeCreated(dest)) throw fsError(`${what} Es wurde nichts verändert.`, err);
        throw fsError(`${what} ${leftoverNote('Eine unvollständige Kopie', dest)}`, err);
      }
      if (!verified) {
        if (await this.removeCreated(dest)) throw fsError('Die Prüfsumme der Kopie stimmt nicht überein; nichts wurde verändert.');
        throw fsError(`Die Prüfsumme der Kopie stimmt nicht überein. ${leftoverNote('Die fehlerhafte Kopie', dest)}`);
      }
      return { dest, linked: false };
    }
    throw new AppError('archive_conflict', 'Es konnte kein freier Zieldateiname gefunden werden.', { retryable: true });
  }

  /**
   * Legt `src` im Ordner `dir` unter `name` ab, ohne etwas zu überschreiben, und entfernt danach `src`.
   * If `src` cannot be removed (e.g. EBUSY), the new entry is taken back; if that fails too, the error says that the
   * file now exists twice (extra hardlink or copy) instead of claiming nothing changed.
   */
  private async moveExclusive(src: string, dir: string, name: string, sha256: string, exactName = false): Promise<string> {
    const { dest, linked } = await this.placeExclusive(src, dir, name, sha256, exactName);
    try {
      await fsp.unlink(src);
    } catch (err) {
      const what = `Die ursprüngliche Datei konnte nicht entfernt werden${errCode(err) ? ` (${errCode(err)})` : ''}.`;
      // nur den soeben angelegten Eintrag zurücknehmen
      if (await this.removeCreated(dest)) throw fsError(`${what} Es wurde nichts verändert.`, err);
      throw fsError(
        `${what} Die Datei liegt weiterhin am bisherigen Ort; ${linked ? 'ein zusätzlicher Verweis (Hardlink) auf dieselbe Datei' : 'eine zusätzliche Kopie'} liegt noch unter „${dest}“ und muss von Hand entfernt werden.`,
        err,
      );
    }
    return dest;
  }

  /** Entfernt leere Ordner von `dir` aufwärts bis zum Archivwurzelordner (nie nicht-leere, nie die Wurzel). */
  private async pruneEmptyDirs(dir: string): Promise<void> {
    while (dir !== this.root && dir.startsWith(this.root)) {
      try {
        await fsp.rmdir(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  }

  /** Verschiebt bereits archivierte Dokumente in andere Archivordner. Erfordert ausdrückliche Bestätigung. */
  async relocate(items: RelocateRequest[], opts: { confirmed: boolean; trigger?: string }): Promise<ArchiveResult> {
    if (!opts.confirmed) throw permissionError('Dateiaktionen erfordern eine ausdrückliche Bestätigung des Benutzers.');
    const result: ArchiveResult = { items: [], success: 0, skipped: 0, failed: 0, conflicts: 0 };
    for (const req of items) {
      let outcome: ArchiveResult['items'][number];
      try {
        outcome = await this.relocateOne(req, opts);
      } catch (err) {
        const info = toErrorInfo(err);
        this.ctx.logger.error('archive', 'Umlagern fehlgeschlagen', { documentId: req.documentId, error: err });
        this.audit.log({
          action: 'archive.relocate',
          actor: 'user',
          trigger: opts.trigger ?? 'manual',
          confirmed: true,
          entityIds: [req.documentId],
          success: false,
          error: `${info.message} ${info.details ?? ''}`.trim(),
        });
        outcome = {
          documentId: req.documentId,
          outcome: 'failed',
          targetPath: null,
          message: info.message + (info.details ? ` (${info.details})` : ''),
          auditId: null,
        };
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

  private async relocateOne(req: RelocateRequest, opts: { trigger?: string }): Promise<ArchiveResult['items'][number]> {
    const plan = await this.planRelocate(req);
    const row = this.docs.getRow(req.documentId);
    const fail = (outcome: 'conflict' | 'skipped', message: string) => ({ documentId: row.id, outcome, targetPath: null, message, auditId: null });
    if (plan.blocked) return fail('conflict', plan.conflicts.join(' '));
    if (plan.unchanged) return fail('skipped', 'Die Datei liegt bereits in diesem Ordner.');
    const src = plan._src!;
    const cat = plan._cat!;
    if ((await sha256File(src)) !== row.sha256)
      return fail('conflict', 'Die Archivdatei wurde seit der Archivierung verändert und wird deshalb nicht verschoben.');

    const newAbs = await this.moveExclusive(src, plan._dir!, plan._name!, row.sha256);
    const newRel = toPosix(path.relative(this.root, newAbs));
    const updatedAt = nowIso();
    let addedRelationId: string | null = null;
    const relationsRemoved: RelationRow[] = [];
    const relationsChanged: RelationRow[] = [];
    try {
      this.ctx.database.transaction(() => {
        this.categories.create(cat, false);
        this.db.update(documents).set({ archiveRelPath: newRel, categoryPath: cat, updatedAt }).where(eq(documents.id, row.id)).run();
        const newEntity = this.graph.ensureEntity('category', cat);
        const mine = this.db
          .select()
          .from(relations)
          .where(and(eq(relations.sourceEntityId, row.id), eq(relations.relationType, 'belongs_to')))
          .all();
        const oldEntity = row.categoryPath ? this.graph.findByName('category', row.categoryPath) : undefined;
        const old = oldEntity && oldEntity.id !== newEntity.id ? mine.find((r) => r.targetEntityId === oldEntity.id) : undefined;
        // A rejected relation is the user's decision and stays untouched; only the active assignment is removed.
        if (old && old.status !== 'rejected') {
          relationsRemoved.push({ ...old });
          this.graph.deleteRelation(old.id);
        }
        const target = mine.find((r) => r.targetEntityId === newEntity.id);
        if (!target) {
          addedRelationId = this.graph.link(row.id, newEntity.id, 'belongs_to', { confidence: 1, status: 'confirmed', sourceIds: [row.id] })?.id ?? null;
        } else if (target.status !== 'confirmed') {
          // Relocating is an explicit user decision for the target category, even over an earlier rejection; undo restores the old state.
          relationsChanged.push({ ...target });
          this.graph.setRelationStatus(target.id, 'confirmed');
        }
      });
    } catch (err) {
      // Datenbank nicht angepasst: Datei an den ursprünglichen Ort zurücklegen
      const note = await this.putBackAfterFailedRelocate(newAbs, src, row.sha256);
      if (!note) throw err;
      const info = toErrorInfo(err);
      throw new AppError(info.category, `${info.message} ${note}`, { details: info.details, cause: err });
    }
    await this.pruneEmptyDirs(path.dirname(src));

    const undoData: RelocateUndoData = {
      documentId: row.id,
      fromRel: row.archiveRelPath!,
      toRel: newRel,
      sha256: row.sha256,
      beforeCategoryPath: row.categoryPath,
      beforeUpdatedAt: row.updatedAt,
      afterUpdatedAt: updatedAt,
      addedRelationId,
      relationsRemoved,
      relationsChanged,
    };
    const trigger = opts.trigger ?? 'manual';
    const auditId = this.audit.log({
      action: 'archive.relocate',
      actor: trigger === 'agent_action' ? 'agent' : 'user',
      trigger,
      confirmed: true,
      entityIds: [row.id],
      paths: [src, newAbs],
      before: { path: src, categoryPath: row.categoryPath },
      after: { path: newAbs, categoryPath: cat },
      undo: { type: 'archive_relocate', data: undoData },
    });
    const warnings: string[] = [];
    await this.reindexAfterCommit(row.id, warnings);
    return {
      documentId: row.id,
      outcome: 'success',
      targetPath: newAbs,
      message: [plan.renamed ? `Verschoben nach ${cat} (umbenannt, weil der Name belegt war).` : `Verschoben nach ${cat}.`, ...warnings].join(' '),
      auditId,
    };
  }

  /**
   * Moves a relocated file back to `original` after the database update failed. The original is restored first and
   * the new entry removed afterwards, so the file the database points to always exists.
   * @returns null when the file is back in place without leftovers, else a user-facing note on the actual state
   */
  private async putBackAfterFailedRelocate(moved: string, original: string, sha256: string): Promise<string | null> {
    try {
      await this.placeExclusive(moved, path.dirname(original), path.basename(original), sha256, true);
    } catch (back) {
      this.ctx.logger.error('archive', 'Zurücklegen nach Fehler beim Umlagern gescheitert', { error: back });
      return `Die Datei konnte nicht an den bisherigen Ort zurückgelegt werden und liegt jetzt unter „${moved}“; die Datenbank verweist noch auf „${original}“.`;
    }
    if (await this.removeCreated(moved)) return null;
    return `Die Datei liegt wieder am bisherigen Ort; ${leftoverNote('ein zusätzlicher Eintrag', moved)}`;
  }

  private async relocateUndoCheck(d: RelocateUndoData): Promise<string[]> {
    const conflicts: string[] = [];
    const row = this.db.select().from(documents).where(eq(documents.id, d.documentId)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    if (row.updatedAt !== d.afterUpdatedAt) conflicts.push('Das Dokument wurde seit dem Umlagern verändert.');
    const now = resolveInside(this.root, d.toRel);
    const back = resolveInside(this.root, d.fromRel);
    if (!fs.existsSync(now)) conflicts.push('Die Datei fehlt am neuen Ort im Archiv.');
    else if ((await sha256File(now)) !== d.sha256) conflicts.push('Die Datei wurde seit dem Umlagern verändert.');
    if (fs.existsSync(back)) conflicts.push(`Am ursprünglichen Ort existiert bereits eine Datei: ${back}`);
    conflicts.push(...this.relocateRelationConflicts(d));
    return conflicts;
  }

  /** Category relations touched by relocating must still be as relocating left them, else undo would overwrite a newer decision. */
  private relocateRelationConflicts(d: RelocateUndoData): string[] {
    const conflicts: string[] = [];
    const relation = (id: string) => this.db.select().from(relations).where(eq(relations.id, id)).get();
    const name = (r: Pick<RelationRow, 'targetEntityId'>) => this.graph.getEntity(r.targetEntityId)?.name ?? r.targetEntityId;
    const changed = (r: Pick<RelationRow, 'targetEntityId'>) => `Die Zuordnung zur Kategorie „${name(r)}“ wurde seit dem Umlagern geändert.`;
    if (d.addedRelationId) {
      const added = relation(d.addedRelationId);
      if (added && added.status !== 'confirmed') conflicts.push(changed(added));
    }
    for (const before of d.relationsChanged ?? []) {
      const now = relation(before.id);
      if (now?.status !== 'confirmed') conflicts.push(changed(before));
    }
    for (const before of d.relationsRemoved ?? []) {
      if (!this.graph.getEntity(before.targetEntityId)) {
        conflicts.push(`Die bisherige Kategorie „${d.beforeCategoryPath ?? ''}“ existiert im Wissensgraph nicht mehr.`);
        continue;
      }
      const now = this.db
        .select()
        .from(relations)
        .where(
          and(
            eq(relations.sourceEntityId, before.sourceEntityId),
            eq(relations.targetEntityId, before.targetEntityId),
            eq(relations.relationType, before.relationType),
          ),
        )
        .get();
      if (now || relation(before.id)) conflicts.push(changed(before));
    }
    return conflicts;
  }

  private async relocateUndoRun(d: RelocateUndoData): Promise<string> {
    const now = resolveInside(this.root, d.toRel);
    const back = resolveInside(this.root, d.fromRel);
    await this.moveExclusive(now, path.dirname(back), path.basename(back), d.sha256, true);
    this.ctx.database.transaction(() => {
      this.db
        .update(documents)
        // the old timestamp comes back too: the document is exactly as before, so earlier undo entries (archiving) stay valid
        .set({ archiveRelPath: d.fromRel, categoryPath: d.beforeCategoryPath, updatedAt: d.beforeUpdatedAt ?? nowIso() })
        .where(eq(documents.id, d.documentId))
        .run();
      if (d.addedRelationId) this.graph.deleteRelation(d.addedRelationId);
      for (const { id, ...rest } of d.relationsChanged ?? []) this.db.update(relations).set(rest).where(eq(relations.id, id)).run();
      if (d.relationsRemoved?.length) this.db.insert(relations).values(d.relationsRemoved).run();
      if (d.removedCategory)
        this.graph.link(d.documentId, this.graph.ensureEntity('category', d.removedCategory).id, 'belongs_to', {
          confidence: 1,
          status: 'confirmed',
          sourceIds: [d.documentId],
        });
    });
    await this.pruneEmptyDirs(path.dirname(now));
    await this.docs.indexDocument(d.documentId);
    this.ctx.events.changed('documents', 'knowledge', 'status');
    return 'Umlagern rückgängig gemacht; die Datei liegt wieder am vorherigen Ort.';
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
      if (!(await this.otherCopyRemains(d))) {
        // The archived version is the only copy left: undo puts it back to its origin instead of deleting it.
        const origin = this.putBackOrigin(d);
        if (!origin) conflicts.push('Es gibt keine weitere Kopie der Datei und keinen ursprünglichen Ort – Undo würde die einzige Kopie löschen.');
        else if (!fs.existsSync(path.dirname(origin))) conflicts.push(`Der ursprüngliche Ordner existiert nicht mehr: ${path.dirname(origin)}`);
      }
    }
    return conflicts;
  }

  /**
   * True when, after undo, a file with the archived checksum still exists outside the archive: either a copy that
   * undo restores itself (removed inbox copy / moved original) or an unchanged file at the source or inbox location.
   */
  private async otherCopyRemains(d: UndoData): Promise<boolean> {
    if (d.removedStaged || d.removedSource) return true;
    for (const p of [d.sourcePath, d.stagedPath]) if (p && (await hasChecksum(p, d.sha256))) return true;
    return false;
  }

  /** Location the archived version returns to when it is the only copy left. */
  private putBackOrigin(d: UndoData): string | null {
    return d.sourcePath ?? d.stagedPath;
  }

  private async undoRun(d: UndoData): Promise<string> {
    const abs = d.archiveRel ? path.join(this.root, ...d.archiveRel.split('/')) : null;
    let putBackPath: string | null = null;
    if ((d.mode === 'copy' || d.mode === 'move') && abs) {
      const verifyRestored = async (dest: string) => {
        if ((await sha256File(dest)) !== d.sha256) {
          await fsp.unlink(dest).catch(() => undefined);
          throw fsError('Wiederherstellung konnte nicht verifiziert werden.');
        }
      };
      const restoreTo = async (dest: string) => {
        await fsp.copyFile(abs, dest, fs.constants.COPYFILE_EXCL);
        await verifyRestored(dest);
      };
      const origin = (await this.otherCopyRemains(d)) ? null : this.putBackOrigin(d);
      if (d.removedStaged && d.stagedPath) await restoreTo(d.stagedPath);
      if (d.removedSource && d.sourcePath) await restoreTo(d.sourcePath);
      if (origin) {
        // Never overwrite whatever is at the origin now (e.g. the edited original): a taken name becomes "Name (2).ext".
        putBackPath = await this.copyExclusive(abs, path.dirname(origin), path.basename(origin));
        await verifyRestored(putBackPath);
      }
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
        .set({
          ...d.before,
          stagedPath: d.removedStaged ? d.stagedPath : d.before.stagedPath,
          // the document now refers to the file that actually holds its content
          ...(putBackPath ? (d.sourcePath ? { sourcePath: putBackPath } : { stagedPath: putBackPath }) : {}),
          updatedAt: nowIso(),
        })
        .where(eq(documents.id, d.documentId))
        .run();
      for (const rid of d.relationIds) this.graph.deleteRelation(rid);
    });
    await this.docs.indexDocument(d.documentId);
    this.ctx.events.emit('document:unarchived', { documentId: d.documentId });
    this.ctx.events.changed('documents', 'knowledge', 'status');
    if (putBackPath && path.basename(putBackPath) !== path.basename(this.putBackOrigin(d)!))
      return `Archivierung rückgängig gemacht. Am ursprünglichen Ort liegt inzwischen eine andere Fassung; sie bleibt unberührt, und die archivierte Fassung liegt jetzt als „${path.basename(putBackPath)}“ daneben. Es wurde nichts gelöscht.`;
    return d.mode === 'ignore'
      ? 'Ignorieren rückgängig gemacht.'
      : d.mode === 'index_only'
        ? 'Indexierung rückgängig gemacht.'
        : 'Archivierung rückgängig gemacht; die Datei liegt wieder am ursprünglichen Ort.';
  }

  // ---------- Archivzustand ----------
  /** Vergleicht Datenbank- und Dateisystemzustand des Archivs. */
  async verify(): Promise<VerifyReport> {
    const rows = this.db
      .select()
      .from(documents)
      .where(inArray(documents.status, ['archived']))
      .all();
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
      let entries: fs.Dirent[];
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
