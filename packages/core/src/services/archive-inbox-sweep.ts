import type fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { documents } from '../db/schema';
import { sha256File } from '../util/hash';
import { hasChecksum } from './archive-files';
import { archivePathOf, archiveRootOf } from './archive-model';
import type { ArchiveDeps } from './archive-deps';

/** Regular files below `dir` that `known` does not contain (unreadable folders are skipped). */
export async function untrackedFiles(dir: string, known: Set<string>): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await untrackedFiles(full, known)));
    else if (entry.isFile() && !known.has(path.resolve(full))) found.push(full);
  }
  return found;
}

/** A fresh inbox file may belong to an import that has not recorded its document yet. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** True when the file is old enough to be no part of a running import; a copy keeps the original's mtime on Windows. */
async function isSettled(file: string): Promise<boolean> {
  try {
    const { mtimeMs, ctimeMs, birthtimeMs } = await fsp.stat(file);
    return Date.now() - Math.max(mtimeMs, ctimeMs, birthtimeMs) > ORPHAN_GRACE_MS;
  } catch {
    return false;
  }
}

/** Removes inbox files no document refers to (e.g. after a crash during import) once an intact archive copy has the same content; returns the count. */
export async function sweepOrphanInboxCopies(deps: ArchiveDeps): Promise<number> {
  const db = deps.ctx.database.db;
  const known = new Set(
    db
      .select({ staged: documents.stagedPath })
      .from(documents)
      .where(isNotNull(documents.stagedPath))
      .all()
      .map((r) => path.resolve(r.staged!)),
  );
  let removed = 0;
  let kept = 0;
  for (const file of await untrackedFiles(deps.ctx.paths.inbox, known)) {
    if ((await isSettled(file)) && (await hasArchivedTwin(deps, await sha256File(file).catch(() => '')))) {
      if (await deps.files.removeCreated(file)) removed += 1;
      else kept += 1;
    } else kept += 1;
  }
  if (kept > 0) deps.ctx.logger.warn('archive', 'Inbox files without a document were kept', { count: kept });
  return removed;
}

async function hasArchivedTwin(deps: ArchiveDeps, sha256: string): Promise<boolean> {
  if (!sha256) return false;
  const twins = deps.ctx.database.db
    .select({ rel: documents.archiveRelPath })
    .from(documents)
    .where(and(eq(documents.status, 'archived'), eq(documents.sha256, sha256), isNotNull(documents.archiveRelPath)))
    .all();
  for (const twin of twins) if (await hasChecksum(archivePathOf(archiveRootOf(deps), twin.rel!), sha256)) return true;
  return false;
}
