import type { OpenItemStatus } from '@archivist/shared';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/database';
import { openItems } from '../db/schema';
import { withSubject } from '../db/subject-filter';
import type { OpenItemRow } from './open-item-fields';

export const ACTIVE_STATUSES: OpenItemStatus[] = ['open', 'waiting', 'blocked'];

export interface OpenItemFilter {
  status?: OpenItemStatus;
  topicId?: string;
  projectId?: string;
  onlyActive?: boolean;
}

function condition(filter: OpenItemFilter) {
  const conditions = [];
  if (filter.status) conditions.push(eq(openItems.status, filter.status));
  if (filter.onlyActive) conditions.push(inArray(openItems.status, ACTIVE_STATUSES));
  // the main topic/project or a further one (#287)
  if (filter.topicId) conditions.push(withSubject({ idCol: openItems.id, mainCol: openItems.topicId, subjectId: filter.topicId }));
  if (filter.projectId) conditions.push(withSubject({ idCol: openItems.id, mainCol: openItems.projectId, subjectId: filter.projectId }));
  return conditions.length ? and(...conditions) : undefined;
}

/** Newest first; without `limit` all matching rows (internal callers), the IPC channel always pages. */
export function openItemRows(db: Db, opts: OpenItemFilter & { limit?: number; offset?: number }): OpenItemRow[] {
  const query = db.select().from(openItems).where(condition(opts)).orderBy(desc(openItems.createdAt), desc(openItems.id));
  return opts.limit === undefined
    ? query.all()
    : query
        .limit(opts.limit)
        .offset(opts.offset ?? 0)
        .all();
}

export function countOpenItemRows(db: Db, filter: OpenItemFilter): number {
  return db.select({ n: count() }).from(openItems).where(condition(filter)).get()?.n ?? 0;
}
