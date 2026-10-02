import type { EntityType, GraphEntity, GraphRelation, RelationMethod, RelationStatus, RelationType } from '@archivist/shared';
import { and, eq, or } from 'drizzle-orm';
import type { Db } from '../../db/database';
import { entities, relations } from '../../db/schema';

export type EntityRow = typeof entities.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;

/** Statuses that count as a current, visible assignment. */
export const ACTIVE_STATUSES: RelationStatus[] = ['proposed', 'confirmed'];

/** Identifies a relation: both ends and its type. */
export interface RelationKey {
  sourceId: string;
  targetId: string;
  relationType: RelationType;
}

/** The end of the relation that is not `id`. */
export const otherEndOf = (relation: Pick<RelationRow, 'sourceEntityId' | 'targetEntityId'>, id: string): string =>
  relation.sourceEntityId === id ? relation.targetEntityId : relation.sourceEntityId;

export const mapEntity = (row: EntityRow): GraphEntity => ({
  id: row.id,
  type: row.type as EntityType,
  name: row.name,
  description: row.description,
  aliases: row.aliases,
  roles: row.roles,
  duplicateOfId: row.duplicateOfId,
  isSelf: row.isSelf,
  status: row.status,
  ...(row.unconfirmed ? { unconfirmed: true } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const mapRelation = (row: RelationRow): GraphRelation => ({
  id: row.id,
  sourceEntityId: row.sourceEntityId,
  targetEntityId: row.targetEntityId,
  relationType: row.relationType as RelationType,
  confidence: row.confidence,
  sourceIds: row.sourceIds,
  status: row.status as RelationStatus,
  origin: row.origin,
  runId: row.runId,
  method: (row.method as RelationMethod | null) ?? null,
  evidence: row.evidence,
  resolvedByUser: row.resolvedByUser,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const entityRow = (db: Db, id: string): EntityRow | undefined => db.select().from(entities).where(eq(entities.id, id)).get();

export const relationRow = (db: Db, id: string): RelationRow | undefined => db.select().from(relations).where(eq(relations.id, id)).get();

export const relationRowsOf = (db: Db, entityId: string): RelationRow[] =>
  db
    .select()
    .from(relations)
    .where(or(eq(relations.sourceEntityId, entityId), eq(relations.targetEntityId, entityId)))
    .all();

export const findRelationRow = (db: Db, key: RelationKey): RelationRow | undefined =>
  db
    .select()
    .from(relations)
    .where(and(eq(relations.sourceEntityId, key.sourceId), eq(relations.targetEntityId, key.targetId), eq(relations.relationType, key.relationType)))
    .get();
