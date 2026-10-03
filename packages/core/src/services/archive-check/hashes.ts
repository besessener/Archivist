import path from 'node:path';
import { reportChangedFile } from './storage';
import type { CheckedDocument } from './documents';
import type { CheckRun } from './findings';

const CURSOR_KEY = 'archive-check.hash-cursor';
const MISMATCH_KEY = 'archive-check.hash-mismatch';
/** One run reads at most this many archive files … */
const BATCH_FILES = 25;
/** … or about this many bytes (a single larger file still counts as one batch). */
const BATCH_BYTES = 256 * 1024 * 1024;

const absolutePath = (root: string, relativePath: string) => path.join(root, ...relativePath.split('/'));

function storedIds(run: CheckRun): Set<string> {
  try {
    return new Set(JSON.parse(run.deps.appState.get(MISMATCH_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** The next documents after the cursor (wrapping around), limited by file count and bytes. */
function nextBatch(ordered: CheckedDocument[], cursor: string): CheckedDocument[] {
  const start = ordered.findIndex((document) => document.id > cursor);
  const rotated = start < 0 ? ordered : [...ordered.slice(start), ...ordered.slice(0, start)];
  const batch: CheckedDocument[] = [];
  let bytes = 0;
  for (const document of rotated) {
    if (batch.length >= BATCH_FILES || (batch.length > 0 && bytes + document.size > BATCH_BYTES)) break;
    batch.push(document);
    bytes += document.size;
  }
  return batch;
}

/**
 * Rolling checksum check: every run reads the next batch of archive files in the worker and compares the checksum;
 * files found changed are read again on every run until they match again, so their hint stays open in between.
 */
export async function checkArchiveHashes(run: CheckRun, archived: CheckedDocument[]): Promise<void> {
  const { deps } = run;
  const root = deps.settings.get().archiveRoot;
  const placed = archived.filter((document) => document.status === 'archived' && document.archiveRelPath).toSorted((a, b) => a.id.localeCompare(b.id));
  const mismatched = storedIds(run);
  const cursor = deps.appState.get(CURSOR_KEY) ?? '';
  const known = placed.filter((document) => mismatched.has(document.id));
  const batch = nextBatch(placed, cursor);
  const verified = new Map<string, CheckedDocument>();
  for (const document of [...known, ...batch]) verified.set(document.id, document);
  const result = new Set<string>();
  for (const document of verified.values()) {
    run.signal?.throwIfAborted();
    const hash = await deps.pool.run('hashFile', { path: absolutePath(root, document.archiveRelPath!) }).catch(() => null);
    if (hash === null) continue; // missing or unreadable files are reported by the storage check
    if (hash !== document.sha256) {
      result.add(document.id);
      reportChangedFile(run, {
        document,
        explanation: `Die Prüfsumme der Datei ${absolutePath(root, document.archiveRelPath!)} weicht von der beim Archivieren ab. Sie wurde möglicherweise überschrieben oder beschädigt.`,
      });
    }
  }
  // documents of the batch that matched leave the list; the others of the stored list stay (e.g. files not readable right now)
  for (const id of mismatched) if (!verified.has(id) && placed.some((document) => document.id === id)) result.add(id);
  deps.appState.set(MISMATCH_KEY, JSON.stringify([...result]));
  deps.appState.set(CURSOR_KEY, batch.at(-1) && batch.at(-1)!.id !== placed.at(-1)?.id ? batch.at(-1)!.id : '');
}
