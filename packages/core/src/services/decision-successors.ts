import type { Decision } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/database';
import { decisions, relations } from '../db/schema';

const CHUNK = 500;

/** The decisions that replace each given decision: the one whose `supersedes` column names it, plus those linked by a confirmed `supersedes` relation (several replacements live there only). */
export function successorsOf(db: Db, ids: string[]): Map<string, Decision['supersededBy']> {
  const replacedBy = new Map<string, Set<string>>();
  const remember = (oldId: string, newId: string) => replacedBy.set(oldId, (replacedBy.get(oldId) ?? new Set()).add(newId));
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    for (const row of db
      .select({ id: decisions.id, old: decisions.supersedesDecisionId })
      .from(decisions)
      .where(inArray(decisions.supersedesDecisionId, chunk))
      .all())
      remember(row.old!, row.id);
    for (const row of db
      .select({ newId: relations.sourceEntityId, oldId: relations.targetEntityId })
      .from(relations)
      .where(and(eq(relations.relationType, 'supersedes'), eq(relations.status, 'confirmed'), inArray(relations.targetEntityId, chunk)))
      .all())
      remember(row.oldId, row.newId);
  }
  const successorIds = [...new Set([...replacedBy.values()].flatMap((set) => [...set]))];
  const titles = new Map<string, string>();
  for (let start = 0; start < successorIds.length; start += CHUNK)
    for (const row of db
      .select({ id: decisions.id, title: decisions.title })
      .from(decisions)
      .where(inArray(decisions.id, successorIds.slice(start, start + CHUNK)))
      .all())
      titles.set(row.id, row.title);
  return new Map([...replacedBy].map(([oldId, newIds]) => [oldId, [...newIds].flatMap((id) => (titles.has(id) ? [{ id, title: titles.get(id)! }] : []))]));
}
