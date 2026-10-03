import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context';
import { AppError, fsError, toErrorInfo } from '../util/errors';
import { sha256File } from '../util/hash';
import { newId } from '../util/ids';
import { uniquePath } from '../util/paths';

/** Attempts to find a free target name before giving up. */
const NAME_ATTEMPTS = 5;
/** Marks a copy that is still being written; never a name the archive hands out. */
const PARTIAL_SUFFIX = '.partial';
const NO_FREE_NAME = 'Es konnte kein freier Zieldateiname gefunden werden.';

export const errorCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/** User-facing note for a file that could not be cleaned up and is still lying around. */
export const leftoverNote = (what: string, p: string) => `${what} liegt noch unter „${p}“ und muss von Hand entfernt werden.`;

const withCode = (sentence: string, err: unknown) => `${sentence}${errorCode(err) ? ` (${errorCode(err)})` : ''}.`;

/** True when `p` is a readable file whose content has the given checksum. */
export async function hasChecksum(p: string, sha256: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile() && (await sha256File(p)) === sha256;
  } catch {
    return false;
  }
}

/** Open errors that only mean the file is read-only. */
const READ_ONLY_CODES = new Set(['EACCES', 'EPERM']);
/** Folder flushes the platform or file system does not offer (Windows cannot open folders). */
const NO_FOLDER_FLUSH_CODES = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']);

async function flushFile(p: string): Promise<void> {
  const file = await fsp.open(p, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Windows flushes only through a writable handle, so a read-only copy of ours is writable just for the flush. */
async function flushOwnFile(p: string): Promise<void> {
  try {
    return await flushFile(p);
  } catch (err) {
    if (!READ_ONLY_CODES.has(errorCode(err) ?? '')) throw err;
  }
  const permissions = (await fsp.stat(p)).mode & 0o7777;
  await fsp.chmod(p, permissions | 0o200);
  try {
    await flushFile(p);
  } finally {
    await fsp.chmod(p, permissions);
  }
}

/** Flushes a file and its folder entry to disk. */
async function syncToDisk(p: string): Promise<void> {
  await flushOwnFile(p);
  await flushFolderOf(p);
}

/** Flushes the folder entry of `p`; only a folder flush the platform does not offer is skipped. */
async function flushFolderOf(p: string): Promise<void> {
  try {
    const folder = await fsp.open(path.dirname(p), 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } catch (err) {
    if (!NO_FOLDER_FLUSH_CODES.has(errorCode(err) ?? '')) throw err;
  }
}

/** Removes empty folders from `dir` upwards to `root` (never non-empty ones, never the root). */
export async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  let current = dir;
  while (current !== root && current.startsWith(root)) {
    try {
      await fsp.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export interface FilePlacement {
  source: string;
  dir: string;
  name: string;
  sha256: string;
  /** `exact`: a taken name is a conflict; `unique`: falls back to „Name (2).ext“. */
  naming: 'exact' | 'unique';
}

interface PlacedFile {
  dest: string;
  linked: boolean;
}

export interface MovedFile {
  moved: string;
  original: string;
  sha256: string;
}

/** File operations of the archive that never overwrite anything and never leave a partial file unreported. */
export class ArchiveFileOps {
  constructor(private readonly ctx: AppContext) {}

  /** Removes a file this service has just created; false when it is still there and must be reported to the user. */
  async removeCreated(p: string): Promise<boolean> {
    try {
      await fsp.unlink(p);
      return true;
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return true;
      this.ctx.logger.error('archive', 'Could not remove the file just created', { path: p, error: err });
      return false;
    }
  }

  /** Copies `source` into `dir` without overwriting anything; a failed or interrupted copy never sits under the final name. */
  async copyExclusive(target: { source: string; dir: string; fileName: string }): Promise<string> {
    await fsp.mkdir(target.dir, { recursive: true });
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
      const dest = await uniquePath(target.dir, target.fileName);
      const published = await this.copyViaTemporary(target.source, dest);
      if (published) return dest;
    }
    throw new AppError('archive_conflict', NO_FREE_NAME, { retryable: true });
  }

  /** False when `dest` is taken; the file appears under `dest` only complete (hard link from a flushed temporary copy). */
  private async copyViaTemporary(source: string, dest: string): Promise<boolean> {
    const temporary = `${dest}.${newId()}${PARTIAL_SUFFIX}`;
    try {
      await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      await syncToDisk(temporary);
    } catch (err) {
      return this.failCopy(err, temporary);
    }
    try {
      await fsp.link(temporary, dest);
    } catch (err) {
      await this.removeCreated(temporary);
      if (errorCode(err) === 'EEXIST') return false; // someone else's file: never touch it, try the next free name
      return this.copyDirect(source, dest); // no hard links on this file system
    }
    await this.removeCreated(temporary);
    await flushFolderOf(dest).catch((err) => this.failCopy(err, dest)); // the final name must survive a power cut, too
    return true;
  }

  private async copyDirect(source: string, dest: string): Promise<boolean> {
    try {
      await fsp.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
      await syncToDisk(dest);
      return true;
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return false;
      return this.failCopy(err, dest);
    }
  }

  /** Places a second, verified version of the source (hard link, else checked copy) without overwriting anything. */
  async placeExclusive(placement: FilePlacement): Promise<PlacedFile> {
    await fsp.mkdir(placement.dir, { recursive: true });
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
      const dest = placement.naming === 'exact' ? path.join(placement.dir, placement.name) : await uniquePath(placement.dir, placement.name);
      const placed = await this.placeAt(placement, dest);
      if (placed !== 'taken') return placed;
      if (placement.naming === 'exact') throw new AppError('archive_conflict', `Am Zielort existiert bereits eine Datei: ${dest}`);
    }
    throw new AppError('archive_conflict', NO_FREE_NAME, { retryable: true });
  }

  /** Places the source like `placeExclusive`, then removes it; if that fails, the new entry is taken back or reported. */
  async moveExclusive(placement: FilePlacement): Promise<string> {
    const { dest, linked } = await this.placeExclusive(placement);
    await syncToDisk(dest).catch((err) => this.failCopy(err, dest));
    try {
      await fsp.unlink(placement.source);
    } catch (err) {
      const what = withCode('Die ursprüngliche Datei konnte nicht entfernt werden', err);
      if (await this.removeCreated(dest)) throw fsError(`${what} Es wurde nichts verändert.`, { cause: err });
      throw fsError(
        `${what} Die Datei liegt weiterhin am bisherigen Ort; ${linked ? 'ein zusätzlicher Verweis (Hardlink) auf dieselbe Datei' : 'eine zusätzliche Kopie'} liegt noch unter „${dest}“ und muss von Hand entfernt werden.`,
        { cause: err },
      );
    }
    return dest;
  }

  /** Runs the database part of a file move; if it fails, the file goes back so database and disk agree again (#221, #238). */
  async commitOrPutBack<T>(file: MovedFile & { caseOnly: boolean }, commit: () => T): Promise<T> {
    try {
      return this.ctx.database.transaction(commit);
    } catch (err) {
      const note = file.caseOnly
        ? await fsp.rename(file.moved, file.original).then(
            () => null,
            () => `Die Datei liegt noch unter ${file.moved}.`,
          )
        : await this.putBack(file);
      if (!note) throw err;
      const info = toErrorInfo(err);
      throw new AppError(info.category, `${info.message} ${note}`, { details: info.details, cause: err });
    }
  }

  /** Moves a file back to `original` (restored first, so the file the database points to always exists); null when clean. */
  async putBack(file: MovedFile): Promise<string | null> {
    try {
      await this.placeExclusive({
        source: file.moved,
        dir: path.dirname(file.original),
        name: path.basename(file.original),
        sha256: file.sha256,
        naming: 'exact',
      });
    } catch (back) {
      this.ctx.logger.error('archive', 'Could not put the file back after a failed relocation', { error: back });
      return `Die Datei konnte nicht an den bisherigen Ort zurückgelegt werden und liegt jetzt unter „${file.moved}“; die Datenbank verweist noch auf „${file.original}“.`;
    }
    if (await this.removeCreated(file.moved)) return null;
    return `Die Datei liegt wieder am bisherigen Ort; ${leftoverNote('ein zusätzlicher Eintrag', file.moved)}`;
  }

  private async placeAt(placement: FilePlacement, dest: string): Promise<PlacedFile | 'taken'> {
    try {
      await fsp.link(placement.source, dest);
      return { dest, linked: true };
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return 'taken';
    }
    // file system without hard links (or another drive): copy with checksum
    return (await this.copyVerified(placement, dest)) ? { dest, linked: false } : 'taken';
  }

  /** False when `dest` is taken; throws (after cleaning up) when the copy fails or does not match. */
  private async copyVerified(placement: FilePlacement, dest: string): Promise<boolean> {
    let verified: boolean;
    try {
      await fsp.copyFile(placement.source, dest, fs.constants.COPYFILE_EXCL);
      verified = await hasChecksum(dest, placement.sha256);
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return false;
      return this.failCopy(err, dest);
    }
    if (verified) return true;
    if (await this.removeCreated(dest)) throw fsError('Die Prüfsumme der Kopie stimmt nicht überein; nichts wurde verändert.');
    throw fsError(`Die Prüfsumme der Kopie stimmt nicht überein. ${leftoverNote('Die fehlerhafte Kopie', dest)}`);
  }

  private async failCopy(err: unknown, dest: string): Promise<never> {
    const what = withCode('Die Datei konnte nicht kopiert werden', err);
    if (await this.removeCreated(dest)) throw fsError(`${what} Es wurde nichts verändert.`, { cause: err });
    throw fsError(`${what} ${leftoverNote('Eine unvollständige Kopie', dest)}`, { cause: err });
  }
}
