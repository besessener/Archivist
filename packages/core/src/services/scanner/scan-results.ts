import type { ScanFile, ScanFileStatus, ScanSummary } from '@archivist/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/database';
import { scanFiles, scanRoots } from '../../db/schema';
import { mapFile } from './scan-files';

export interface ScanResultsQuery {
  rootId?: string;
  status?: ScanFileStatus;
  limit?: number;
  offset?: number;
}

/** One page of the found files (newest first) with the total behind the filter and the summary of the latest scan. */
export function queryScanResults(db: Db, options: ScanResultsQuery = {}): { files: ScanFile[]; lastSummary: ScanSummary | null; total: number } {
  const conditions = [];
  if (options.rootId) conditions.push(eq(scanFiles.rootId, options.rootId));
  if (options.status) conditions.push(eq(scanFiles.status, options.status));
  const where = conditions.length ? and(...conditions) : undefined;
  const files = db
    .select()
    .from(scanFiles)
    .where(where)
    .orderBy(desc(scanFiles.lastSeenAt), scanFiles.name, scanFiles.id)
    .limit(options.limit ?? 500)
    .offset(options.offset ?? 0)
    .all()
    .map(mapFile);
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(scanFiles)
      .where(where)
      .get()?.n ?? 0;
  const latest = db
    .select()
    .from(scanRoots)
    .orderBy(desc(scanRoots.lastScanAt))
    .all()
    .find((root) => root.lastSummary);
  return { files, lastSummary: (latest?.lastSummary as unknown as ScanSummary | null) ?? null, total };
}
