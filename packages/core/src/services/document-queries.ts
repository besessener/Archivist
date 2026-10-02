import type { DocumentStatus } from '@archivist/shared';
import { and, count, desc, eq, getTableColumns, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/database';
import { documents, entities } from '../db/schema';

/** Characters of the text read for list entries: enough for the 600-character preview, never the whole text (#214). */
const PREVIEW_SOURCE_CHARS = 2000;
const { extractedText: _fullText, ...LIST_COLUMNS } = getTableColumns(documents);
void _fullText;

export interface DocumentListQuery {
  status?: DocumentStatus;
  statuses?: DocumentStatus[];
  ids?: string[];
  topicId?: string;
  projectId?: string;
  query?: string;
  limit?: number;
}

type DocRow = typeof documents.$inferSelect;

export interface DocumentListRows {
  /** Rows with only the beginning of the text in `extractedText`; `textLength` is the full length. */
  rows: Array<DocRow & { textLength: number }>;
  /** Names of the referenced topics/projects. */
  names: Array<[string, string]>;
}

/**
 * Newest documents matching the filter, with the topic/project names – a pure read that runs on the main
 * connection or in the read worker (#214, #215). Reads only the beginning of each text.
 */
export function queryDocumentList(db: Db, opts: DocumentListQuery = {}): DocumentListRows {
  const conds = [];
  if (opts.status) conds.push(eq(documents.status, opts.status));
  if (opts.statuses) conds.push(inArray(documents.status, opts.statuses));
  if (opts.ids) conds.push(inArray(documents.id, opts.ids));
  if (opts.topicId) conds.push(eq(documents.topicId, opts.topicId));
  if (opts.projectId) conds.push(eq(documents.projectId, opts.projectId));
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    conds.push(or(like(documents.title, q), like(documents.originalName, q), like(documents.summary, q)));
  }
  const rows = db
    .select({
      ...LIST_COLUMNS,
      extractedText: sql<string>`substr(${documents.extractedText}, 1, ${PREVIEW_SOURCE_CHARS})`,
      textLength: sql<number>`length(${documents.extractedText})`,
    })
    .from(documents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(opts.limit ?? 300)
    .all();
  const ids = [...new Set(rows.flatMap((r) => [r.topicId, r.projectId]).filter((x): x is string => Boolean(x)))];
  const names = ids.length
    ? db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(inArray(entities.id, ids))
        .all()
        .map((e): [string, string] => [e.id, e.name])
    : [];
  return { rows, names };
}

/** Number of documents per status (inbox badge) – a COUNT instead of loading the list (#214). */
export function documentCounts(db: Db): Partial<Record<DocumentStatus, number>> {
  const rows = db.select({ status: documents.status, n: count() }).from(documents).groupBy(documents.status).all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
