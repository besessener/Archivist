import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { AppError, fsError } from '../util/errors';
import { sha256File } from '../util/hash';
import { errorCode } from './archive-files';
import { exists, toAbs, type MigratePlan, type RootRoute } from './archive-root-plan';
import type { JobContext } from './jobs';

/** Suffix of the temporary file a copy is written to before it gets its final name in the new folder. */
const PARTIAL_SUFFIX = '.archivist-partial';

/** What a move created in the new folder, so a failure or undo can remove exactly that. */
export interface CreatedByMove {
  /** Files the move copied into the new folder (relative POSIX path + checksum); undo removes them if unchanged. */
  created: Array<{ rel: string; sha256: string }>;
  /** Directories the move created (relative POSIX paths); undo removes them again if they are empty. */
  createdDirs: string[];
  /** The move created the new archive folder itself. */
  createdRoot: boolean;
}

const alreadyTaken = (rel: string) =>
  new AppError('archive_conflict', `Im neuen Ordner liegt bereits eine Datei unter „${rel}“. Archivist überschreibt nichts.`);

/** Gives the verified temporary copy its final name without ever overwriting (hard link, else rename). */
async function publishCopy(partial: string, target: { dest: string; rel: string }): Promise<void> {
  try {
    await fsp.link(partial, target.dest); // fails if dest exists: never overwrites
    await fsp.unlink(partial);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') throw alreadyTaken(target.rel);
    // file system without hard links
    if (exists(target.dest)) throw alreadyTaken(target.rel);
    await fsp.rename(partial, target.dest);
  }
}

/** Copies under a temporary name, verifies the checksum, then publishes; null when an identical file is already there. */
async function copyVerified(target: { source: string; dest: string; rel: string }): Promise<string | null> {
  const { source, dest, rel } = target;
  const sha = await sha256File(source);
  if (exists(dest)) {
    if ((await sha256File(dest).catch(() => null)) === sha) return null;
    throw new AppError('archive_conflict', `Im neuen Ordner liegt bereits eine andere Datei unter „${rel}“. Archivist überschreibt nichts.`);
  }
  const partial = `${dest}${PARTIAL_SUFFIX}`;
  await fsp.rm(partial, { force: true }); // leftover of an interrupted earlier move (our own temporary name)
  try {
    await fsp.copyFile(source, partial, fs.constants.COPYFILE_EXCL);
    if ((await sha256File(partial)) !== sha) throw fsError(`Die Kopie von „${rel}“ stimmt nicht mit dem Original überein.`);
    await publishCopy(partial, { dest, rel });
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    if (err instanceof AppError) throw err;
    throw fsError(`„${rel}“ konnte nicht kopiert werden${errorCode(err) ? ` (${errorCode(err)})` : ''}.`, { cause: err });
  }
  return sha;
}

/** Removes copies and directories a move created (best effort); returns the files that could not be removed. */
export async function removeCreatedByMove(to: string, made: CreatedByMove): Promise<string[]> {
  const kept: string[] = [];
  for (const f of made.created) {
    const abs = toAbs(to, f.rel);
    try {
      if ((await sha256File(abs)) === f.sha256) await fsp.unlink(abs);
      else kept.push(f.rel);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') kept.push(f.rel);
    }
  }
  const depth = (rel: string) => rel.split('/').length;
  for (const rel of [...made.createdDirs].sort((a, b) => depth(b) - depth(a))) await fsp.rmdir(toAbs(to, rel)).catch(() => undefined);
  if (made.createdRoot) await fsp.rmdir(to).catch(() => undefined);
  return kept;
}

/** Copies the planned tree into the new folder, recording in `made` what it created (also when it fails midway). */
export async function copyTree(job: JobContext<RootRoute>, work: { plan: MigratePlan; made: CreatedByMove }): Promise<void> {
  const { from, to } = job.payload;
  const { plan, made } = work;
  made.createdRoot = !exists(to);
  await fsp.mkdir(to, { recursive: true });
  for (const rel of plan.dirs) {
    try {
      await fsp.mkdir(toAbs(to, rel));
      made.createdDirs.push(rel);
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw fsError(`Der Ordner „${rel}“ konnte nicht angelegt werden.`, { cause: err });
    }
  }
  const total = plan.files.length;
  for (const [i, f] of plan.files.entries()) {
    job.throwIfCancelled();
    job.report(total ? (i / total) * 0.95 : 0, `Kopiere und prüfe Datei ${i + 1} von ${total} …`);
    const sha = await copyVerified({ source: toAbs(from, f.rel), dest: toAbs(to, f.rel), rel: f.rel });
    if (sha) made.created.push({ rel: f.rel, sha256: sha });
  }
}
