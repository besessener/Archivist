import type { DecisionStatus } from '@archivist/shared';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/database';
import { decisions } from '../db/schema';
import { withSubject } from '../db/subject-filter';
import type { DecisionRow } from './decision-fields';

export interface DecisionFilter {
  status?: DecisionStatus;
  statuses?: DecisionStatus[];
  ids?: string[];
  topicId?: string;
  projectId?: string;
}

function condition(filter: DecisionFilter) {
  const conditions = [];
  if (filter.status) conditions.push(eq(decisions.status, filter.status));
  if (filter.statuses) conditions.push(inArray(decisions.status, filter.statuses));
  if (filter.ids) conditions.push(inArray(decisions.id, filter.ids));
  // the main topic/project or a further one (#287)
  if (filter.topicId) conditions.push(withSubject({ idCol: decisions.id, mainCol: decisions.topicId, subjectId: filter.topicId }));
  if (filter.projectId) conditions.push(withSubject({ idCol: decisions.id, mainCol: decisions.projectId, subjectId: filter.projectId }));
  return conditions.length ? and(...conditions) : undefined;
}

/** Newest first; without `limit` all matching rows (internal callers), the IPC channel always pages. */
export function decisionRows(db: Db, opts: DecisionFilter & { limit?: number; offset?: number }): DecisionRow[] {
  const query = db.select().from(decisions).where(condition(opts)).orderBy(desc(decisions.decidedAt), desc(decisions.createdAt), desc(decisions.id));
  return opts.limit === undefined
    ? query.all()
    : query
        .limit(opts.limit)
        .offset(opts.offset ?? 0)
        .all();
}

export function countDecisionRows(db: Db, filter: DecisionFilter): number {
  return db.select({ n: count() }).from(decisions).where(condition(filter)).get()?.n ?? 0;
}
