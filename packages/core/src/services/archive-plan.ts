import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveItemRequest, ArchivePlan, ArchivePlanItem, DocumentProposal } from '@archivist/shared';
import { AppError } from '../util/errors';
import { assertRealInside, resolveInside, sanitizeCategoryPath, sanitizeFileName, uniquePath } from '../util/paths';
import { archivePathOf, archiveRootOf, toPosix } from './archive-model';
import type { DocRow } from './documents';
import type { ArchiveDeps } from './archive-deps';

/** Where a copy or move puts the file; absent for blocked items, `ignore` and `index_only`. */
export interface ArchiveTarget {
  categoryPath: string;
  fileName: string;
  dir: string;
}

export interface PlannedArchive {
  item: ArchivePlanItem;
  target?: ArchiveTarget;
}

/** Topic/project the user chose: an omitted field falls back to the proposal, `null` or empty means "without". */
export function assignmentNames(req: ArchiveItemRequest, proposal: DocumentProposal | null): { topicName: string | null; projectName: string | null } {
  return {
    topicName: (req.topic !== undefined ? req.topic : proposal?.topic)?.trim() || null,
    projectName: (req.project !== undefined ? req.project : proposal?.project)?.trim() || null,
  };
}

const blocked = (base: ArchivePlanItem, conflict: string): PlannedArchive => ({ item: { ...base, blocked: true, conflicts: [conflict] } });

const errorText = (err: unknown, fallback: string) => (err instanceof AppError ? err.message : fallback);

function basePlanItem(row: DocRow, req: ArchiveItemRequest): ArchivePlanItem {
  const proposal = row.proposal as DocumentProposal | null;
  return {
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
}

/** Summary line of an archive preview. */
function planSummary(plan: ArchivePlanItem[], counts: { moves: number; newCategories: string[] }): string {
  const { moves, newCategories } = counts;
  const ready = plan.filter((p) => !p.blocked).length;
  const moveNote = moves ? `, ${moves} werden verschoben (Original wird entfernt)` : '';
  const categoryNote = newCategories.length ? `, neue Hauptkategorie(n): ${newCategories.join(', ')}` : '';
  return `${ready} von ${plan.length} Dateien bereit${moveNote}${categoryNote}.`;
}

/** Plans archiving (target paths, duplicates, conflicts, new main categories) without changing anything. */
export class ArchivePlanner {
  constructor(private readonly deps: ArchiveDeps) {}

  async preview(items: ArchiveItemRequest[]): Promise<ArchivePlan> {
    const plan = (await Promise.all(items.map((i) => this.plan(i)))).map((p) => p.item);
    const newCategories = [...new Set(plan.flatMap((p) => p.newCategories))];
    const moves = plan.filter((p) => p.action === 'move' && !p.blocked).length;
    return {
      items: plan,
      newCategories,
      requiresStrongConfirmation: moves > 0 || newCategories.length > 0,
      summary: planSummary(plan, { moves, newCategories }),
    };
  }

  async plan(req: ArchiveItemRequest): Promise<PlannedArchive> {
    const row = this.deps.docs.getRow(req.documentId);
    const proposal = row.proposal as DocumentProposal | null;
    const base = basePlanItem(row, req);
    if (row.status === 'archived') return blocked(base, 'Das Dokument ist bereits archiviert.');
    if (req.mode === 'ignore') return { item: { ...base, sourcePath: row.sourcePath } };
    if (row.status === 'quarantined') return blocked(base, 'Die Datei liegt in Quarantäne. Bitte zuerst in der Inbox „Trotzdem importieren“ wählen.');
    base.duplicates = this.archivedDuplicates(row);
    base.affected.push(...this.assignedEntities(req, proposal));
    try {
      base.sourcePath = this.deps.docs.readablePath(row);
    } catch {
      return blocked(base, 'Die Quelldatei ist nicht mehr vorhanden.');
    }
    if (req.mode === 'index_only') return { item: base };
    return this.planTarget({ row, req, proposal, base });
  }

  private archivedDuplicates(row: DocRow): ArchivePlanItem['duplicates'] {
    const root = archiveRootOf(this.deps);
    return this.deps.docs
      .findDuplicates(row.sha256, row.id)
      .filter((d) => d.status === 'archived' || d.status === 'indexed_only')
      .map((d) => ({ documentId: d.id, title: d.title, archivePath: d.archiveRelPath ? archivePathOf(root, d.archiveRelPath) : null }));
  }

  private assignedEntities(req: ArchiveItemRequest, proposal: DocumentProposal | null): ArchivePlanItem['affected'] {
    const assigned = assignmentNames(req, proposal);
    const named = [
      ['topic', assigned.topicName],
      ['project', assigned.projectName],
    ] as const;
    return named.flatMap(([type, name]) => {
      const entity = name ? this.deps.graph.findByName(type, name) : null;
      return entity ? [{ type: entity.type, id: entity.id, label: entity.name }] : [];
    });
  }

  private async planTarget(input: { row: DocRow; req: ArchiveItemRequest; proposal: DocumentProposal | null; base: ArchivePlanItem }): Promise<PlannedArchive> {
    const { row, req, proposal, base } = input;
    const root = archiveRootOf(this.deps);
    let categoryPath: string;
    try {
      categoryPath = sanitizeCategoryPath(req.categoryPath ?? proposal?.location.categoryPath ?? row.categoryPath ?? '');
    } catch (err) {
      return blocked(base, errorText(err, 'Ungültiger Zielordner.'));
    }
    let fileName = sanitizeFileName(req.fileName ?? proposal?.location.fileName ?? row.originalName);
    if (path.extname(fileName).slice(1).toLowerCase() !== row.ext) fileName = `${fileName}.${row.ext}`;
    const dir = resolveInside(root, categoryPath);
    try {
      await assertRealInside(root, dir);
    } catch (err) {
      return blocked(base, errorText(err, 'Zielpfad ungültig.'));
    }
    const targetPath = await uniquePath(dir, fileName);
    const collided = path.basename(targetPath) !== fileName;
    const newMain = this.deps.categories.needsApproval(categoryPath);
    const item: ArchivePlanItem = {
      ...base,
      targetPath,
      targetRelPath: toPosix(path.relative(root, targetPath)),
      renamed: collided || fileName !== row.originalName,
      // Only the user's original counts as "removed"; Archivist's own inbox copy is merely cleaned up.
      willRemoveSource: req.mode === 'move' && Boolean(row.sourcePath && row.sourcePath !== row.stagedPath && fs.existsSync(row.sourcePath)),
      removesInboxCopy: Boolean(row.stagedPath && fs.existsSync(row.stagedPath)),
      conflicts: collided
        ? [`Im Zielordner existiert bereits „${fileName}“ – die Datei wird als „${path.basename(targetPath)}“ abgelegt (nichts wird überschrieben).`]
        : [],
      newCategories: newMain ? [newMain] : [],
    };
    return { item, target: { categoryPath, fileName, dir } };
  }
}
