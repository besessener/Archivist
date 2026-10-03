import type fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveDeps } from './archive-deps';
import { PARTIAL_COPY_PATTERN } from './archive-files';
import { isSettled } from './archive-inbox-sweep';
import { archiveRootOf } from './archive-model';

/** Files below `dir` named like a temporary archive copy (unreadable folders are skipped). */
async function partialCopies(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await partialCopies(full)));
    else if (entry.isFile() && PARTIAL_COPY_PATTERN.test(entry.name)) found.push(full);
  }
  return found;
}

/** Removes temporary copies a crash left in the archive once they are more than an hour old; call only while no file action runs. Returns the count. */
export async function sweepStalePartialCopies(deps: ArchiveDeps): Promise<number> {
  let removed = 0;
  let kept = 0;
  for (const file of await partialCopies(archiveRootOf(deps))) {
    if ((await isSettled(file)) && (await deps.files.removeCreated(file))) removed += 1;
    else kept += 1;
  }
  if (removed > 0) deps.ctx.logger.info('archive', 'Removed leftover partial copies', { count: removed });
  if (kept > 0) deps.ctx.logger.info('archive', 'Partial copies kept (recent or locked)', { count: kept });
  return removed;
}
