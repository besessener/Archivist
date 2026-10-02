import type { Db } from '../db/database';
import { countDocumentList, documentCounts, queryDocumentList, type DocumentListQuery } from '../services/document-queries';
import { buildTimeline, type TimelineQuery } from '../services/timeline';

/**
 * Read-only database queries that may run in the read worker with its own read-only connection (#215).
 * Pure functions of the database: no services, no writes, no events.
 */
export const readTasks = {
  timeline: (db: Db, q: TimelineQuery) => buildTimeline(db, q),
  documentList: (db: Db, q: DocumentListQuery) => queryDocumentList(db, q),
  documentCounts: (db: Db, _q: Record<string, never>) => documentCounts(db),
  documentCount: (db: Db, q: Omit<DocumentListQuery, 'limit'>) => countDocumentList(db, q),
};

export type ReadTaskName = keyof typeof readTasks;
export type ReadTaskInput<K extends ReadTaskName> = Parameters<(typeof readTasks)[K]>[1];
export type ReadTaskOutput<K extends ReadTaskName> = ReturnType<(typeof readTasks)[K]>;
