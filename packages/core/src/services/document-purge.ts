import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog, llmTransmissions } from '../db/schema';

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

/** Drops the metadata undo steps of the purged documents (they hold the old summary); the chained entries themselves stay. */
export function purgeMetadataUndo(ctx: AppContext, documentIds: string[]): void {
  if (documentIds.length === 0) return;
  const purged = new Set(documentIds);
  const { db } = ctx.database;
  const rows = db
    .select({ id: auditLog.id, undoType: auditLog.undoType, undoData: auditLog.undoData })
    .from(auditLog)
    .where(inArray(auditLog.undoType, ['document_metadata', 'document_metadata_bulk']))
    .all();
  for (const row of rows) {
    const data = row.undoData as { id?: string; items?: { id: string }[] } | null;
    const kept = data?.items?.filter((item) => !purged.has(item.id));
    const touched = data?.items ? kept!.length !== data.items.length : purged.has(data?.id ?? '');
    if (!touched) continue;
    const patch = kept?.length ? { undoData: { items: kept } } : { undoType: null, undoData: null };
    db.update(auditLog).set(patch).where(eq(auditLog.id, row.id)).run();
  }
}

/** Rewrites the database file so deleted text no longer sits in free pages, the search index or the write-ahead log. */
export function compactDatabase(ctx: AppContext): boolean {
  const { sqlite } = ctx.database;
  try {
    sqlite.exec("INSERT INTO search_fts(search_fts) VALUES ('optimize')");
    sqlite.exec('VACUUM');
    const [checkpoint] = sqlite.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (checkpoint?.busy) throw new Error('The write-ahead log could not be truncated because the database is busy.');
    return true;
  } catch (error) {
    ctx.logger.warn('documents', 'Compacting the database after emptying the trash failed', { error });
    return false;
  }
}
