import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { documents, relations } from '../db/schema';
import { sha256File } from '../util/hash';
import { nowIso } from '../util/ids';
import { resolveInside } from '../util/paths';
import { pruneEmptyDirs } from './archive-files';
import { archiveRootOf, type RelationRow, type RelocateUndoData } from './archive-model';
import type { ArchiveDeps } from './archive-deps';

/** Undo of a relocation: the file goes back to its previous folder, the category relations as they were. */
export class RelocateUndo {
  constructor(private readonly deps: ArchiveDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async check(d: RelocateUndoData): Promise<string[]> {
    if (this.deps.locks.isRootChangeActive()) return ['Der Archivordner wird gerade umgestellt.'];
    const conflicts: string[] = [];
    const row = this.db.select().from(documents).where(eq(documents.id, d.documentId)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    if (row.updatedAt !== d.afterUpdatedAt) conflicts.push('Das Dokument wurde seit dem Umlagern verändert.');
    const root = archiveRootOf(this.deps);
    const now = resolveInside(root, d.toRel);
    const back = resolveInside(root, d.fromRel);
    if (!fs.existsSync(now)) conflicts.push('Die Datei fehlt am neuen Ort im Archiv.');
    else if ((await sha256File(now)) !== d.sha256) conflicts.push('Die Datei wurde seit dem Umlagern verändert.');
    if (fs.existsSync(back)) conflicts.push(`Am ursprünglichen Ort existiert bereits eine Datei: ${back}`);
    conflicts.push(...this.relationConflicts(d));
    return conflicts;
  }

  async run(d: RelocateUndoData): Promise<string> {
    const root = archiveRootOf(this.deps);
    const now = resolveInside(root, d.toRel);
    const back = resolveInside(root, d.fromRel);
    await this.deps.files.moveExclusive({ source: now, dir: path.dirname(back), name: path.basename(back), sha256: d.sha256, naming: 'exact' });
    await this.deps.files.commitOrPutBack({ moved: back, original: now, sha256: d.sha256, caseOnly: false }, () => this.restore(d));
    await pruneEmptyDirs(root, path.dirname(now));
    await this.deps.docs.indexDocument(d.documentId);
    this.deps.ctx.events.changed('documents', 'knowledge', 'status');
    return 'Umlagern rückgängig gemacht; die Datei liegt wieder am vorherigen Ort.';
  }

  private restore(d: RelocateUndoData): void {
    const { graph } = this.deps;
    this.db
      .update(documents)
      // the old timestamp comes back too: the document is exactly as before, so earlier undo entries (archiving) stay valid
      .set({ archiveRelPath: d.fromRel, categoryPath: d.beforeCategoryPath, updatedAt: d.beforeUpdatedAt ?? nowIso() })
      .where(eq(documents.id, d.documentId))
      .run();
    if (d.addedRelationId) graph.deleteRelation(d.addedRelationId);
    for (const { id, ...rest } of d.relationsChanged ?? []) this.db.update(relations).set(rest).where(eq(relations.id, id)).run();
    if (d.relationsRemoved?.length) this.db.insert(relations).values(d.relationsRemoved).run();
    if (d.removedCategory)
      graph.link(
        { sourceId: d.documentId, targetId: graph.ensureEntity({ type: 'category', name: d.removedCategory }).id, relationType: 'belongs_to' },
        {
          confidence: 1,
          status: 'confirmed',
          sourceIds: [d.documentId],
        },
      );
  }

  /** Category relations touched by relocating must still be as relocating left them, else undo would overwrite a newer decision. */
  private relationConflicts(d: RelocateUndoData): string[] {
    const changed = (r: Pick<RelationRow, 'targetEntityId'>) => `Die Zuordnung zur Kategorie „${this.entityName(r)}“ wurde seit dem Umlagern geändert.`;
    const conflicts: string[] = [];
    const added = d.addedRelationId ? this.relation(d.addedRelationId) : undefined;
    if (added && added.status !== 'confirmed') conflicts.push(changed(added));
    for (const before of d.relationsChanged ?? []) if (this.relation(before.id)?.status !== 'confirmed') conflicts.push(changed(before));
    for (const before of d.relationsRemoved ?? []) {
      if (!this.deps.graph.getEntity(before.targetEntityId))
        conflicts.push(`Die bisherige Kategorie „${d.beforeCategoryPath ?? ''}“ existiert im Wissensgraph nicht mehr.`);
      else if (this.sameRelation(before) || this.relation(before.id)) conflicts.push(changed(before));
    }
    return conflicts;
  }

  private relation(id: string): RelationRow | undefined {
    return this.db.select().from(relations).where(eq(relations.id, id)).get();
  }

  private sameRelation(before: RelationRow): RelationRow | undefined {
    return this.db
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
  }

  private entityName(r: Pick<RelationRow, 'targetEntityId'>): string {
    return this.deps.graph.getEntity(r.targetEntityId)?.name ?? r.targetEntityId;
  }
}
