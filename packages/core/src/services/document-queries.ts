import type { DocumentStatus } from '@archivist/shared';
import { and, count, desc, eq, getTableColumns, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/database';
import { documents, entities } from '../db/schema';
import { withSubject } from '../db/subject-filter';
import { termMatches } from './search-keywords';

/** Characters of the text read for list entries: enough for the 600-character preview, never the whole text (#214). */
const PREVIEW_SOURCE_CHARS = 2000;
const { extractedText: _fullText, ...LIST_COLUMNS } = getTableColumns(documents);

export interface DocumentListQuery {
  status?: DocumentStatus;
  statuses?: DocumentStatus[];
  ids?: string[];
  topicId?: string;
  projectId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

type DocumentRow = typeof documents.$inferSelect;

export interface DocumentListRows {
  /** Rows with only the beginning of the text in `extractedText`; `textLength` is the full length. */
  rows: Array<DocumentRow & { textLength: number }>;
  /** Names of the referenced topics/projects. */
  names: Array<[string, string]>;
}

/** The WHERE clause of a document list (everything but the limit). */
function listFilter(opts: DocumentListQuery) {
  const conditions = [];
  if (opts.status) conditions.push(eq(documents.status, opts.status));
  if (opts.statuses) conditions.push(inArray(documents.status, opts.statuses));
  if (opts.ids) conditions.push(inArray(documents.id, opts.ids));
  // the main topic/project or a further one (#287)
  if (opts.topicId) conditions.push(withSubject({ idCol: documents.id, mainCol: documents.topicId, subjectId: opts.topicId }));
  if (opts.projectId) conditions.push(withSubject({ idCol: documents.id, mainCol: documents.projectId, subjectId: opts.projectId }));
  if (opts.query?.trim()) {
    const pattern = `%${opts.query.trim()}%`;
    // title, file name and summary as typed, plus every term somewhere in the full text – not all in one chunk (#171)
    const inText = and(
      ...termMatches(opts.query).map(
        (match) => sql`${documents.id} IN (SELECT entity_id FROM search_fts WHERE entity_type = 'document' AND search_fts MATCH ${match})`,
      ),
    );
    conditions.push(or(like(documents.title, pattern), like(documents.originalName, pattern), like(documents.summary, pattern), inText));
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** Newest documents matching the filter with topic/project names; a pure read for main connection or read worker (#214, #215). */
export function queryDocumentList(db: Db, opts: DocumentListQuery = {}): DocumentListRows {
  const rows = db
    .select({
      ...LIST_COLUMNS,
      extractedText: sql<string>`substr(${documents.extractedText}, 1, ${PREVIEW_SOURCE_CHARS})`,
      textLength: sql<number>`length(${documents.extractedText})`,
    })
    .from(documents)
    .where(listFilter(opts))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(opts.limit ?? 300)
    .offset(opts.offset ?? 0)
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

/** Number of documents matching a list filter, regardless of its limit – lists say „N von M“ instead of passing N off as the total (#222). */
export function countDocumentList(db: Db, opts: Omit<DocumentListQuery, 'limit'> = {}): number {
  return db.select({ n: count() }).from(documents).where(listFilter(opts)).get()?.n ?? 0;
}
