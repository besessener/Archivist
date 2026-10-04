import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog, llmTransmissions } from '../db/schema';

/** Pages one merge step of the search index writes: 15–35 ms on the main thread (measured at 5,000–20,000 documents). */
const MERGE_PAGES_PER_STEP = 100;

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

/** Leaves no deleted text in the file: freed pages are zeroed on delete (secure_delete), the search index merges deleted entries away, the write-ahead log is emptied. */
export async function compactDatabase(ctx: AppContext): Promise<boolean> {
  const { database } = ctx;
  try {
    await mergeSearchIndex(database.sqlite);
    database.wipeEarlierDeletions();
    const [checkpoint] = database.sqlite.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (checkpoint?.busy) throw new Error('The write-ahead log could not be truncated because the database is busy.');
    return true;
  } catch (error) {
    ctx.logger.warn('documents', 'Compacting the database after emptying the trash failed', { error });
    return false;
  }
}

/** Merges the search index into one segment like 'optimize' (which drops deleted entries), in short steps that let the event loop run. */
async function mergeSearchIndex(sqlite: Database.Database): Promise<void> {
  const merge = sqlite.prepare("INSERT INTO search_fts(search_fts, rank) VALUES ('merge', ?)");
  const totalChanges = sqlite.prepare('SELECT total_changes()').pluck();
  for (;;) {
    const before = totalChanges.get() as number;
    merge.run(-MERGE_PAGES_PER_STEP);
    if ((totalChanges.get() as number) - before < 2) return; // FTS5: fewer than two changes means nothing was left to merge
    await yieldToEventLoop();
  }
}
