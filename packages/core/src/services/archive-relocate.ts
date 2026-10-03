import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { documents, relations } from '../db/schema';
import { AppError } from '../util/errors';
import { sha256File } from '../util/hash';
import { nowIso } from '../util/ids';
import { assertRealInside, resolveInside, sanitizeCategoryPath, uniquePath } from '../util/paths';
import { pruneEmptyDirs } from './archive-files';
import {
  archiveRootOf,
  outcomeWithoutChange,
  toPosix,
  type ArchiveOutcome,
  type RelationRow,
  type RelocatePlanItem,
  type RelocateRequest,
  type RelocateUndoData,
} from './archive-model';
import type { DocRow } from './documents';
import type { ArchiveDeps } from './archive-deps';

interface RelocateSource {
  file: string;
  dir: string;
  name: string;
  categoryPath: string;
}

interface PlannedRelocation {
  item: RelocatePlanItem;
  source?: RelocateSource;
}

/** Category relation changes of one relocation, recorded for its undo. */
interface RelationEdits {
  addedRelationId: string | null;
  relationsRemoved: RelationRow[];
  relationsChanged: RelationRow[];
}

const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

const errorText = (err: unknown, fallback: string) => (err instanceof AppError ? err.message : fallback);

/** Moves already archived documents into other archive folders, never overwriting and logged with undo. */
export class ArchiveRelocator {
  constructor(
    private readonly deps: ArchiveDeps,
    private readonly reindexAfterCommit: (documentId: string, warnings: string[]) => Promise<void>,
  ) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Preview (changes nothing): what would relocating do? */
  async preview(items: RelocateRequest[]): Promise<RelocatePlanItem[]> {
    return (await Promise.all(items.map((i) => this.plan(i)))).map((p) => p.item);
  }

  private async plan(req: RelocateRequest): Promise<PlannedRelocation> {
    const row = this.deps.docs.getRow(req.documentId);
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
    const block = (message: string): PlannedRelocation => ({ item: { ...base, blocked: true, conflicts: [message] } });
    if (row.status !== 'archived' || !row.archiveRelPath || row.archiveMode === 'index_only')
      return block('Nur archivierte Dokumente mit einer Datei im Archiv lassen sich umlagern.');
    let categoryPath: string;
    try {
      categoryPath = sanitizeCategoryPath(req.categoryPath);
    } catch (err) {
      return block(errorText(err, 'Ungültiger Zielordner.'));
    }
    const main = this.deps.categories.needsApproval(categoryPath);
    if (main) return block(`Die Hauptkategorie „${main}“ gibt es noch nicht. Neue Hauptkategorien müssen vorher ausdrücklich angelegt werden.`);
    const root = archiveRootOf(this.deps);
    let file: string;
    let dir: string;
    try {
      file = resolveInside(root, row.archiveRelPath);
      dir = resolveInside(root, categoryPath);
      await assertRealInside(root, file);
      await assertRealInside(root, dir);
    } catch (err) {
      return block(errorText(err, 'Pfad ungültig.'));
    }
    if (!fs.existsSync(file)) return block('Die Datei fehlt am erwarteten Ort im Archiv.');
    const withCategory = { ...base, categoryPath };
    if (sameDir(path.dirname(file), dir)) return { item: { ...withCategory, unchanged: true, toRelPath: row.archiveRelPath } };
    const name = path.basename(file);
    const target = await uniquePath(dir, name);
    const collided = path.basename(target) !== name;
    const item: RelocatePlanItem = {
      ...withCategory,
      toRelPath: toPosix(path.relative(root, target)),
      renamed: collided,
      conflicts: collided
        ? [`Im Zielordner existiert bereits „${name}“ – die Datei wird als „${path.basename(target)}“ abgelegt (nichts wird überschrieben).`]
        : [],
    };
    return { item, source: { file, dir, name, categoryPath } };
  }

  async relocateOne(req: RelocateRequest, trigger: string): Promise<ArchiveOutcome> {
    const plan = await this.plan(req);
    const row = this.deps.docs.getRow(req.documentId);
    const refuse = (outcome: 'conflict' | 'skipped', message: string) => outcomeWithoutChange({ documentId: row.id, outcome, message });
    if (plan.item.blocked) return refuse('conflict', plan.item.conflicts.join(' '));
    if (plan.item.unchanged) return refuse('skipped', 'Die Datei liegt bereits in diesem Ordner.');
    const source = plan.source!;
    if ((await sha256File(source.file)) !== row.sha256)
      return refuse('conflict', 'Die Archivdatei wurde seit der Archivierung verändert und wird deshalb nicht verschoben.');

    const root = archiveRootOf(this.deps);
    const newAbs = await this.deps.files.moveExclusive({ source: source.file, dir: source.dir, name: source.name, sha256: row.sha256, naming: 'unique' });
    const newRel = toPosix(path.relative(root, newAbs));
    const updatedAt = nowIso();
    const edits = await this.deps.files.commitOrPutBack({ moved: newAbs, original: source.file, sha256: row.sha256, caseOnly: false }, () =>
      this.writeRelocated(row, { categoryPath: source.categoryPath, newRel, updatedAt }),
    );
    await pruneEmptyDirs(root, path.dirname(source.file));
    const undoData: RelocateUndoData = {
      documentId: row.id,
      fromRel: row.archiveRelPath!,
      toRel: newRel,
      sha256: row.sha256,
      beforeCategoryPath: row.categoryPath,
      beforeUpdatedAt: row.updatedAt,
      afterUpdatedAt: updatedAt,
      ...edits,
    };
    const auditId = this.deps.audit.log({
      action: 'archive.relocate',
      actor: trigger === 'agent_action' ? 'agent' : 'user',
      trigger,
      confirmed: true,
      entityIds: [row.id],
      paths: [source.file, newAbs],
      before: { path: source.file, categoryPath: row.categoryPath },
      after: { path: newAbs, categoryPath: source.categoryPath },
      undo: { type: 'archive_relocate', data: undoData },
    });
    const warnings: string[] = [];
    await this.reindexAfterCommit(row.id, warnings);
    const moved = plan.item.renamed
      ? `Verschoben nach ${source.categoryPath} (umbenannt, weil der Name belegt war).`
      : `Verschoben nach ${source.categoryPath}.`;
    return { documentId: row.id, outcome: 'success', targetPath: newAbs, message: [moved, ...warnings].join(' '), auditId };
  }

  /** Runs inside the transaction: new path and category, category relation moved along. */
  private writeRelocated(row: DocRow, target: { categoryPath: string; newRel: string; updatedAt: string }): RelationEdits {
    const { graph } = this.deps;
    const edits: RelationEdits = { addedRelationId: null, relationsRemoved: [], relationsChanged: [] };
    this.deps.categories.create(target.categoryPath, { confirmed: false });
    this.db
      .update(documents)
      .set({ archiveRelPath: target.newRel, categoryPath: target.categoryPath, updatedAt: target.updatedAt })
      .where(eq(documents.id, row.id))
      .run();
    const newEntity = graph.ensureEntity('category', target.categoryPath);
    const mine = this.db
      .select()
      .from(relations)
      .where(and(eq(relations.sourceEntityId, row.id), eq(relations.relationType, 'belongs_to')))
      .all();
    const oldEntity = row.categoryPath ? graph.findByName('category', row.categoryPath) : undefined;
    const old = oldEntity && oldEntity.id !== newEntity.id ? mine.find((r) => r.targetEntityId === oldEntity.id) : undefined;
    // A rejected relation is the user's decision and stays untouched; only the active assignment is removed.
    if (old && old.status !== 'rejected') {
      edits.relationsRemoved.push({ ...old });
      graph.deleteRelation(old.id);
    }
    const current = mine.find((r) => r.targetEntityId === newEntity.id);
    if (!current) {
      edits.addedRelationId = graph.link(row.id, newEntity.id, 'belongs_to', { confidence: 1, status: 'confirmed', sourceIds: [row.id] })?.id ?? null;
    } else if (current.status !== 'confirmed') {
      // Relocating is an explicit user decision for the target category, even over an earlier rejection.
      edits.relationsChanged.push({ ...current });
      graph.setRelationStatus(current.id, 'confirmed');
    }
    return edits;
  }
}
