import type { Contradiction } from '@archivist/shared';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/database';
import { contradictions } from '../db/schema';
import type { ContradictionRow } from './contradiction-notices';

export interface ContradictionFilter {
  status?: Contradiction['status'];
  /** Only contradictions that name this entry among the affected ones. */
  entityId?: string;
}

export const toContradiction = (r: ContradictionRow): Contradiction => ({
  id: r.id,
  title: r.title,
  description: r.description,
  affectedEntityIds: r.affectedEntityIds,
  excerpts: r.excerpts as Contradiction['excerpts'],
  sourceIds: r.sourceIds,
  timestamps: r.timestamps,
  confidence: r.confidence,
  status: r.status as Contradiction['status'],
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

function condition(filter: ContradictionFilter) {
  const conditions = [];
  if (filter.status) conditions.push(eq(contradictions.status, filter.status));
  if (filter.entityId) conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${contradictions.affectedEntityIds}) WHERE value = ${filter.entityId})`);
  return conditions.length ? and(...conditions) : undefined;
}

/** Newest first; without `page` all matching contradictions (internal callers), the IPC channel always pages. */
export function listContradictions(db: Db, filter: ContradictionFilter, page?: { limit: number; offset: number }): Contradiction[] {
  const query = db.select().from(contradictions).where(condition(filter)).orderBy(desc(contradictions.createdAt), desc(contradictions.id));
  return (page ? query.limit(page.limit).offset(page.offset).all() : query.all()).map(toContradiction);
}

export function countContradictions(db: Db, filter: ContradictionFilter): number {
  return db.select({ n: count() }).from(contradictions).where(condition(filter)).get()?.n ?? 0;
}
