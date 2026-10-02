import type { Db } from '../db/database';
import { countDocumentList, documentCounts, queryDocumentList, type DocumentListQuery } from '../services/document-queries';
import { buildTimeline, type TimelineQuery } from '../services/timeline';

/** Read-only queries for the read worker (#215): pure functions of the database – no services, writes or events. */
export const readTasks = {
  timeline: (db: Db, query: TimelineQuery) => buildTimeline(db, query),
  documentList: (db: Db, query: DocumentListQuery) => queryDocumentList(db, query),
  documentCounts: (db: Db, _query: Record<string, never>) => documentCounts(db),
  documentCount: (db: Db, query: Omit<DocumentListQuery, 'limit'>) => countDocumentList(db, query),
};

export type ReadTaskName = keyof typeof readTasks;
export type ReadTaskInput<K extends ReadTaskName> = Parameters<(typeof readTasks)[K]>[1];
export type ReadTaskOutput<K extends ReadTaskName> = ReturnType<(typeof readTasks)[K]>;
