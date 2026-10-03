import { sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { llmTransmissions } from '../db/schema';

/** Empties the preview of every logged transmission that concerned one of the documents (the entry itself stays); returns how many. */
export function clearTransmissionPreviews(ctx: AppContext, documentIds: string[]): number {
  if (documentIds.length === 0) return 0;
  const ids = JSON.stringify(documentIds);
  return ctx.database.db
    .update(llmTransmissions)
    .set({ preview: '' })
    .where(sql`EXISTS (SELECT 1 FROM json_each(${llmTransmissions.documentIds}) WHERE value IN (SELECT value FROM json_each(${ids})))`)
    .run().changes;
}

/** Rewrites the database file so deleted text no longer sits in free pages, the search index or the write-ahead log. */
export function compactDatabase(ctx: AppContext): boolean {
  const { sqlite } = ctx.database;
  try {
    sqlite.exec("INSERT INTO search_fts(search_fts) VALUES ('optimize')");
    sqlite.exec('VACUUM');
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    return true;
  } catch (error) {
    ctx.logger.warn('documents', 'Compacting the database after emptying the trash failed', { error });
    return false;
  }
}
