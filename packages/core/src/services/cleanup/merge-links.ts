import type { EntityType, RelationType } from '@archivist/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, relations } from '../../db/schema';
import type { KnowledgeGraphService } from '../knowledge-graph';

type RelationRow = typeof relations.$inferSelect;

/** A relation a merge created, with its timestamp for the undo's conflict check. */
export interface CreatedRelation {
  id: string;
  updatedAt: string;
}

interface MissingLink {
  source: string;
  target: string;
  type: RelationType;
  row: RelationRow;
}

/** Links of merged records: copies the duplicate's links to the kept record and removes them again on undo. */
export class MergeLinks {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  activeRelations(entityId: string): RelationRow[] {
    return this.db
      .select()
      .from(relations)
      .where(and(or(eq(relations.sourceEntityId, entityId), eq(relations.targetEntityId, entityId)), inArray(relations.status, ['proposed', 'confirmed'])))
      .all();
  }

  private exists(source: string, target: string, type: string): boolean {
    return Boolean(
      this.db
        .select({ id: relations.id })
        .from(relations)
        .where(and(eq(relations.sourceEntityId, source), eq(relations.targetEntityId, target), eq(relations.relationType, type)))
        .get(),
    );
  }

  private isSkipped(entityId: string, skipTypes: EntityType[]): boolean {
    if (!skipTypes.length) return false;
    const type = this.db.select({ type: entities.type }).from(entities).where(eq(entities.id, entityId)).get()?.type as EntityType | undefined;
    return Boolean(type && skipTypes.includes(type));
  }

  /** Active links of `fromId` that `toId` does not have yet (same direction and type), except to `skipTypes`. */
  missingLinks(fromId: string, toId: string, skipTypes: EntityType[]): MissingLink[] {
    const out: MissingLink[] = [];
    for (const relation of this.activeRelations(fromId)) {
      const outgoing = relation.sourceEntityId === fromId;
      const other = outgoing ? relation.targetEntityId : relation.sourceEntityId;
      if (other === toId || this.isSkipped(other, skipTypes)) continue;
      const source = outgoing ? toId : other;
      const target = outgoing ? other : toId;
      if (!this.exists(source, target, relation.relationType)) out.push({ source, target, type: relation.relationType as RelationType, row: relation });
    }
    return out;
  }

  /** Creates a link that does not exist yet and returns it for the undo (existing links are never touched). */
  linkNew(
    source: string,
    target: string,
    type: RelationType,
    opts: { confidence: number; status: 'proposed' | 'confirmed'; sourceIds: string[] },
  ): CreatedRelation[] {
    if (this.exists(source, target, type)) return [];
    const relation = this.graph.link(source, target, type, opts);
    return relation ? [{ id: relation.id, updatedAt: relation.updatedAt }] : [];
  }

  copyLinks(fromId: string, toId: string, skipTypes: EntityType[]): CreatedRelation[] {
    return this.missingLinks(fromId, toId, skipTypes).flatMap((link) =>
      this.linkNew(link.source, link.target, link.type, {
        confidence: link.row.confidence,
        status: link.row.status === 'confirmed' ? 'confirmed' : 'proposed',
        sourceIds: link.row.sourceIds,
      }),
    );
  }

  /** The discarded record points to the kept one in the knowledge graph (`duplicate_of`); removed again on undo. */
  markDuplicate(duplicateId: string, keepId: string): CreatedRelation[] {
    return this.linkNew(duplicateId, keepId, 'duplicate_of', { confidence: 1, status: 'confirmed', sourceIds: [] });
  }

  createdRelationConflicts(created: CreatedRelation[]): string[] {
    if (!created.length) return [];
    const current = this.db
      .select({ id: relations.id, updatedAt: relations.updatedAt })
      .from(relations)
      .where(
        inArray(
          relations.id,
          created.map((relation) => relation.id),
        ),
      )
      .all();
    const changed = current.some((relation) => created.find((c) => c.id === relation.id)?.updatedAt !== relation.updatedAt);
    return changed ? ['Eine bei der Zusammenführung übernommene Verknüpfung wurde seitdem geändert.'] : [];
  }

  /** Deletes the relations a merge created (call inside the undo transaction). */
  removeCreated(created: CreatedRelation[]): void {
    if (!created.length) return;
    this.db
      .delete(relations)
      .where(
        inArray(
          relations.id,
          created.map((relation) => relation.id),
        ),
      )
      .run();
  }
}
