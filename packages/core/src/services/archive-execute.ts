import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveItemRequest, DocumentProposal } from '@archivist/shared';
import { and, eq, notInArray } from 'drizzle-orm';
import { documents } from '../db/schema';
import { AppError, toErrorInfo } from '../util/errors';
import { sha256File } from '../util/hash';
import { nowIso } from '../util/ids';
import { normalizeName } from '../util/text';
import type { ExtractedItemProposer } from './archive-extracted-items';
import { errorCode, leftoverNote } from './archive-files';
import { archiveRootOf, outcomeWithoutChange, toPosix, type ArchiveOutcome, type ArchiveUndoData, type ExecuteOptions } from './archive-model';
import { assignmentNames, type ArchivePlanner, type ArchiveTarget, type PlannedArchive } from './archive-plan';
import type { DocRow } from './documents';
import type { RelationChangeSet } from './knowledge-graph';
import type { ArchiveDeps } from './archive-deps';

/** What one archiving needs once its plan has passed every check. */
interface Archiving {
  req: ArchiveItemRequest;
  row: DocRow;
  proposal: DocumentProposal | null;
  trigger: string;
  before: ArchiveUndoData['before'];
}

interface ArchivedCopy {
  targetAbs: string | null;
  archiveRel: string | null;
}

interface RemovedSources {
  removedStaged: boolean;
  removedSource: boolean;
  warnings: string[];
}

const NO_COPY: ArchivedCopy = { targetAbs: null, archiveRel: null };

function snapshotBefore(row: DocRow): ArchiveUndoData['before'] {
  return {
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
}

const isApproved = (category: string, approved: string[]) => approved.some((a) => a.toLowerCase() === category.toLowerCase());

const successMessage = (mode: ArchiveItemRequest['mode']) =>
  mode === 'index_only' ? 'Nur indexiert.' : mode === 'move' ? 'Ins Archiv verschoben.' : 'Ins Archiv kopiert.';

/** Archives one document: verified copy, one transaction for database and graph, sources removed only afterwards. */
export class ArchiveExecutor {
  constructor(
    private readonly deps: ArchiveDeps,
    private readonly parts: { planner: ArchivePlanner; extractedItems: ExtractedItemProposer },
  ) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async executeOne(req: ArchiveItemRequest, opts: ExecuteOptions): Promise<ArchiveOutcome> {
    const plan = await this.parts.planner.plan(req);
    const row = this.deps.docs.getRow(req.documentId);
    if (plan.item.blocked)
      return outcomeWithoutChange({
        documentId: row.id,
        outcome: plan.item.conflicts.some((c) => c.includes('bereits archiviert')) ? 'skipped' : 'conflict',
        message: plan.item.conflicts.join(' '),
      });
    const archiving: Archiving = {
      req,
      row,
      proposal: row.proposal as DocumentProposal | null,
      trigger: opts.trigger ?? 'manual',
      before: snapshotBefore(row),
    };
    if (req.mode === 'ignore') return this.ignore(archiving);
    const refusal = await this.refusal(archiving, { plan, opts });
    if (refusal) return refusal;
    return this.archive(archiving, plan);
  }

  private ignore(archiving: Archiving): ArchiveOutcome {
    const { row, trigger, before } = archiving;
    const updatedAt = nowIso();
    this.db.update(documents).set({ status: 'ignored', archiveMode: 'ignore', updatedAt }).where(eq(documents.id, row.id)).run();
    const undoData: ArchiveUndoData = {
      documentId: row.id,
      mode: 'ignore',
      archiveRel: null,
      sha256: row.sha256,
      sourcePath: row.sourcePath,
      stagedPath: row.stagedPath,
      removedStaged: false,
      removedSource: false,
      before,
      relations: { created: [], changed: [] },
      afterUpdatedAt: updatedAt,
    };
    const auditId = this.deps.audit.log({
      action: 'archive.ignore',
      actor: 'user',
      trigger,
      confirmed: true,
      entityIds: [row.id],
      paths: [row.sourcePath ?? ''].filter(Boolean),
      before: { status: row.status },
      after: { status: 'ignored' },
      undo: { type: 'archive_file', data: undoData },
    });
    return { documentId: row.id, outcome: 'success', targetPath: null, message: 'Ignoriert (keine Dateiaktion).', auditId };
  }

  /** Why the archiving must not run (unconfirmed new main category or move, changed source), if anything. */
  private async refusal(archiving: Archiving, checked: { plan: PlannedArchive; opts: ExecuteOptions }): Promise<ArchiveOutcome | undefined> {
    const { req, row } = archiving;
    const { item } = checked.plan;
    const refuse = (outcome: 'conflict' | 'skipped', message: string) => outcomeWithoutChange({ documentId: row.id, outcome, message });
    if (item.newCategories.length > 0 && !item.newCategories.every((c) => isApproved(c, checked.opts.approveNewCategories)))
      return refuse('conflict', `Neue Hauptkategorie „${item.newCategories.join(', ')}“ wurde nicht bestätigt.`);
    if (req.mode === 'move' && !checked.opts.confirmMove)
      return refuse('skipped', 'Verschieben erfordert eine zusätzliche Bestätigung („Original wird entfernt“).');
    if ((await sha256File(item.sourcePath!)) !== row.sha256)
      return refuse('conflict', 'Die Quelldatei hat sich seit der Analyse verändert. Bitte erneut analysieren.');
    return undefined;
  }

  private async archive(archiving: Archiving, plan: PlannedArchive): Promise<ArchiveOutcome> {
    const { req, row } = archiving;
    const source = plan.item.sourcePath!;
    const copy = req.mode === 'index_only' ? NO_COPY : await this.copyToArchive(source, { target: plan.target!, sha256: row.sha256 });
    const updatedAt = nowIso();
    const relationChanges = await this.commit(archiving, { copy, categoryPath: plan.target?.categoryPath ?? null, updatedAt });
    const removed = req.mode === 'index_only' ? { removedStaged: false, removedSource: false, warnings: [] } : await this.removeSources(row, req.mode);
    let finalUpdatedAt = updatedAt;
    if (removed.removedStaged) {
      finalUpdatedAt = nowIso();
      this.db.update(documents).set({ stagedPath: null, updatedAt: finalUpdatedAt }).where(eq(documents.id, row.id)).run();
    }
    const auditId = this.logArchived(archiving, { source, copy, removed, relations: relationChanges, afterUpdatedAt: finalUpdatedAt });
    // From here on the archiving is committed and undoable: follow-up steps may only add warnings.
    await this.reindexAfterCommit(row.id, removed.warnings);
    this.deps.ctx.events.emit('document:archived', { documentId: row.id, sourcePath: row.sourcePath });
    this.deps.notifications.resolveByDedupePrefix(`classified:${row.id}`);
    try {
      this.parts.extractedItems.propose(row, archiving.proposal);
    } catch (err) {
      this.deps.ctx.logger.error('archive', 'Could not create proposals from the document', { documentId: row.id, error: err });
    }
    return { documentId: row.id, outcome: 'success', targetPath: copy.targetAbs, message: [successMessage(req.mode), ...removed.warnings].join(' '), auditId };
  }

  private async copyToArchive(source: string, verified: { target: ArchiveTarget; sha256: string }): Promise<ArchivedCopy> {
    const { target } = verified;
    const targetAbs = await this.deps.files.copyExclusive({ source, dir: target.dir, fileName: target.fileName });
    let matches: boolean;
    try {
      matches = (await sha256File(targetAbs)) === verified.sha256;
    } catch {
      matches = false;
    }
    if (!matches) {
      // only the copy just created
      const message = (await this.deps.files.removeCreated(targetAbs))
        ? 'Die Prüfsumme der Archivkopie stimmt nicht überein; der Vorgang wurde zurückgenommen.'
        : `Die Prüfsumme der Archivkopie stimmt nicht überein. ${leftoverNote('Die fehlerhafte Kopie', targetAbs)}`;
      throw new AppError('filesystem_error', message, { retryable: true });
    }
    return { targetAbs, archiveRel: toPosix(path.relative(archiveRootOf(this.deps), targetAbs)) };
  }

  /** Database and knowledge graph in one transaction; on failure the copy just made is removed again. */
  private async commit(archiving: Archiving, state: { copy: ArchivedCopy; categoryPath: string | null; updatedAt: string }): Promise<RelationChangeSet> {
    try {
      // only relations the archiving created or changed go into the undo data, never pre-existing (e.g. rejected) ones
      return this.deps.graph.trackRelationChanges(archiving.row.id, () => this.deps.ctx.database.transaction(() => this.writeArchived(archiving, state)))
        .changes;
    } catch (err) {
      const targetAbs = state.copy.targetAbs;
      if (targetAbs && !(await this.deps.files.removeCreated(targetAbs))) {
        const info = toErrorInfo(err);
        throw new AppError(info.category, `${info.message} ${leftoverNote('Die bereits angelegte Archivkopie', targetAbs)}`, {
          details: info.details,
          cause: err,
        });
      }
      throw err;
    }
  }

  private writeArchived(archiving: Archiving, state: { copy: ArchivedCopy; categoryPath: string | null; updatedAt: string }): void {
    const { req, row, proposal } = archiving;
    const { categoryPath, updatedAt } = state;
    const { graph } = this.deps;
    const { topicName, projectName } = assignmentNames(req, proposal);
    if (categoryPath) this.deps.categories.create(categoryPath, { confirmed: true });
    // a name taken over unchanged from the document's analysis stays unconfirmed until the user uses it (#199)
    const fromDocument = (name: string, proposed: string | null | undefined) => normalizeName(name) === normalizeName(proposed ?? '');
    const topic = topicName ? graph.ensureEntity('topic', topicName, null, { fromDocument: fromDocument(topicName, proposal?.topic) }) : null;
    const project = projectName ? graph.ensureEntity('project', projectName, null, { fromDocument: fromDocument(projectName, proposal?.project) }) : null;
    // persons: every mention becomes a person (#274), the stored list uses canonical names
    const people = this.deps.persons.resolveNames(proposal?.persons ?? row.persons, { context: 'document' });
    const claimed = this.db
      .update(documents)
      .set({
        status: req.mode === 'index_only' ? 'indexed_only' : 'archived',
        persons: people.names,
        archiveRelPath: state.copy.archiveRel,
        categoryPath: categoryPath ?? row.categoryPath,
        archiveMode: req.mode,
        // An explicitly emptied field means "without topic/project" and clears an earlier assignment.
        topicId: topic ? topic.id : req.topic !== undefined ? null : row.topicId,
        projectId: project ? project.id : req.project !== undefined ? null : row.projectId,
        archivedAt: updatedAt,
        updatedAt,
      })
      // archived meanwhile by someone else: roll back, the copy made here is removed by the caller (#240)
      .where(and(eq(documents.id, row.id), notInArray(documents.status, ['archived', 'indexed_only'])))
      .run();
    if (!claimed.changes) throw new AppError('archive_conflict', 'Das Dokument wurde inzwischen schon archiviert.');
    this.linkArchived(row, { topicId: topic?.id, projectId: project?.id, categoryPath, personIds: people.entities.map((p) => p.id), proposal });
  }

  private linkArchived(
    row: DocRow,
    links: { topicId?: string; projectId?: string; categoryPath: string | null; personIds: string[]; proposal: DocumentProposal | null },
  ): void {
    const { graph } = this.deps;
    const confidence = row.confidence ?? 0.8;
    if (links.topicId) graph.link(row.id, links.topicId, 'relates_to', { confidence, status: 'confirmed', sourceIds: [row.id] });
    if (links.projectId) graph.link(row.id, links.projectId, 'belongs_to', { confidence, status: 'confirmed', sourceIds: [row.id] });
    if (links.categoryPath)
      graph.link(row.id, graph.ensureEntity('category', links.categoryPath).id, 'belongs_to', { confidence: 1, status: 'confirmed', sourceIds: [row.id] });
    for (const personId of links.personIds) graph.link(personId, row.id, 'produced', { confidence: 0.5, status: 'proposed', sourceIds: [row.id] });
    for (const tag of row.tags)
      graph.link(row.id, graph.ensureEntity('tag', tag).id, 'relates_to', { confidence: 0.6, status: 'confirmed', sourceIds: [row.id] });
    if (links.proposal?.duplicateOfDocumentId)
      graph.link(row.id, links.proposal.duplicateOfDocumentId, 'duplicate_of', { confidence: 0.8, status: 'proposed', sourceIds: [row.id] });
  }

  /** Removes our own inbox copy and, for a confirmed move, the unchanged original – only after a successful commit. */
  private async removeSources(row: DocRow, mode: ArchiveItemRequest['mode']): Promise<RemovedSources> {
    const warnings: string[] = [];
    const removedStaged = row.stagedPath && fs.existsSync(row.stagedPath) ? await this.removeInboxCopy(row, warnings) : false;
    const removedSource = mode === 'move' && row.sourcePath && fs.existsSync(row.sourcePath) ? await this.removeOriginal(row, warnings) : false;
    return { removedStaged, removedSource, warnings };
  }

  private async removeInboxCopy(row: DocRow, warnings: string[]): Promise<boolean> {
    try {
      await fsp.unlink(row.stagedPath!);
      return true;
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return true; // already gone (e.g. cleaned up concurrently)
      // A locked inbox copy must not fail a committed archiving; the kept stagedPath marks it for cleanupInbox().
      this.deps.ctx.logger.warn('archive', 'Could not remove the inbox copy after archiving', { documentId: row.id, error: err });
      warnings.push('Die Kopie im Eingang konnte noch nicht entfernt werden (z. B. weil sie gerade geöffnet ist); sie wird später automatisch entfernt.');
      return false;
    }
  }

  private async removeOriginal(row: DocRow, warnings: string[]): Promise<boolean> {
    const original = row.sourcePath!;
    try {
      if ((await sha256File(original)) === row.sha256) {
        await fsp.unlink(original);
        return true;
      }
      warnings.push('Das Original wurde verändert und deshalb nicht entfernt.');
    } catch (err) {
      warnings.push(`Das Original konnte nicht entfernt werden: ${(err as Error).message}`);
    }
    return false;
  }

  private logArchived(
    archiving: Archiving,
    done: { source: string; copy: ArchivedCopy; removed: RemovedSources; relations: RelationChangeSet; afterUpdatedAt: string },
  ): string {
    const { req, row, trigger, before } = archiving;
    const { removedStaged, removedSource } = done.removed;
    const undoData: ArchiveUndoData = {
      documentId: row.id,
      mode: req.mode,
      archiveRel: done.copy.archiveRel,
      sha256: row.sha256,
      sourcePath: row.sourcePath,
      stagedPath: row.stagedPath,
      removedStaged,
      removedSource,
      before,
      relations: done.relations,
      afterUpdatedAt: done.afterUpdatedAt,
    };
    return this.deps.audit.log({
      action: `archive.${req.mode}`,
      actor: trigger === 'agent_action' ? 'agent' : 'user',
      trigger,
      confirmed: true,
      entityIds: [row.id],
      paths: [done.source, done.copy.targetAbs ?? ''].filter(Boolean),
      before: { status: row.status, path: done.source },
      after: { status: req.mode === 'index_only' ? 'indexed_only' : 'archived', path: done.copy.targetAbs, removedSource, removedStaged },
      undo: { type: 'archive_file', data: undoData },
    });
  }

  /** Updates the search index after a committed file operation; a failure only becomes a warning. */
  async reindexAfterCommit(documentId: string, warnings: string[]): Promise<void> {
    try {
      await this.deps.docs.indexDocument(documentId);
    } catch (err) {
      this.deps.ctx.logger.error('archive', 'Could not update the search index', { documentId, error: err });
      warnings.push('Der Suchindex konnte nicht aktualisiert werden.');
    }
  }
}
