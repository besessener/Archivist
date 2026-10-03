import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, fsError } from '../util/errors';

/** Application state that older versions kept next to the documents; it moves to the per-user data folder. */
const MOVED_ENTRIES = ['database', 'index', 'config', 'logs', 'backups', 'restore-pending.json'];
const MARKER_FILE = 'layout-migration.json';
const STAGE_DIR = '.layout-migration';
const HASH_BLOCK_BYTES = 1024 * 1024;

export interface LayoutMigrationPlaces {
  /** Folder where older versions kept everything (Documents/Archivist). */
  legacyRoot: string;
  /** Folder of the application state (the per-user data folder). */
  appDataRoot: string;
}

export type LayoutMigrationResult = { migrated: false } | { migrated: true; from: string; to: string; entries: string[] };

interface Marker {
  status: 'switching' | 'complete';
  entries: string[];
  from: string;
  at: string;
}

function hashFile(file: string): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BLOCK_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null))
      hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Relative path -> size and checksum of every file below `entry` (a file maps to itself). */
function fingerprint(entry: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      result.set(`${relative}/`, 'dir');
      for (const name of fs.readdirSync(current)) walk(path.join(current, name), `${relative}/${name}`);
      return;
    }
    result.set(relative, stat.isFile() ? `${stat.size}:${hashFile(current)}` : `other:${stat.size}`);
  };
  walk(entry, '');
  return result;
}

function sameContent(a: string, b: string): boolean {
  const first = fingerprint(a);
  const second = fingerprint(b);
  return first.size === second.size && [...first].every(([key, value]) => second.get(key) === value);
}

function isFilledDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function writeMarker(markerFile: string, marker: Marker): void {
  fs.writeFileSync(`${markerFile}.tmp`, JSON.stringify(marker, null, 2), 'utf8');
  fs.renameSync(`${markerFile}.tmp`, markerFile);
}

function readMarker(markerFile: string): Marker | null {
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as Marker;
    return (marker.status === 'switching' || marker.status === 'complete') && Array.isArray(marker.entries) ? marker : null;
  } catch {
    return null;
  }
}

function conflict(target: string): AppError {
  return new AppError(
    'filesystem_error',
    `Archivist verschiebt seine Datenbank und Einstellungen in den Datenordner deines Benutzerprofils, dort liegt aber schon etwas: ${target}. Es wurde nichts verändert. Benenne oder verschiebe diesen Ordner, dann starte Archivist neu.`,
    { retryable: false },
  );
}

/** Renames the verified copies into place (resumable), then removes the old ones; nothing existing is overwritten. */
function switchOver(places: LayoutMigrationPlaces, marker: Marker, markerFile: string): void {
  const stage = path.join(places.appDataRoot, STAGE_DIR);
  for (const name of marker.entries) {
    const staged = path.join(stage, name);
    const target = path.join(places.appDataRoot, name);
    if (!fs.existsSync(staged)) continue;
    if (isFilledDirectory(target) || (fs.existsSync(target) && fs.statSync(target).isFile())) throw conflict(target);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staged, target);
  }
  for (const name of marker.entries) fs.rmSync(path.join(places.legacyRoot, name), { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  writeMarker(markerFile, { ...marker, status: 'complete' });
}

function stageCopies(places: LayoutMigrationPlaces, entries: string[]): void {
  const stage = path.join(places.appDataRoot, STAGE_DIR);
  fs.rmSync(stage, { recursive: true, force: true }); // an unfinished earlier copy is ours and worthless
  fs.mkdirSync(stage, { recursive: true });
  try {
    for (const name of entries) {
      const copy = path.join(stage, name);
      fs.cpSync(path.join(places.legacyRoot, name), copy, { recursive: true, errorOnExist: true, force: false });
      if (!sameContent(path.join(places.legacyRoot, name), copy)) throw new Error(`Verification of ${name} failed`);
    }
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw fsError('Archivist konnte seine Daten nicht in den Datenordner deines Benutzerprofils kopieren. Deine bisherigen Daten sind unverändert.', {
      cause: err,
    });
  }
}

/**
 * Moves the application state of an older install (next to the documents) to the per-user data folder: copy, verify
 * every file by checksum, switch, remove the old copies, leave a marker. Interrupted at any point it resumes on the
 * next start; an existing target is never overwritten.
 */
export function migrateLegacyLayout(places: LayoutMigrationPlaces): LayoutMigrationResult {
  const legacyRoot = path.resolve(places.legacyRoot);
  const appDataRoot = path.resolve(places.appDataRoot);
  const resolved = { legacyRoot, appDataRoot };
  if (legacyRoot === appDataRoot) return { migrated: false };
  fs.mkdirSync(appDataRoot, { recursive: true });
  const markerFile = path.join(appDataRoot, MARKER_FILE);
  const marker = readMarker(markerFile);
  if (marker?.status === 'complete') return { migrated: false };
  if (marker) {
    switchOver(resolved, marker, markerFile);
    return { migrated: true, from: marker.from, to: appDataRoot, entries: marker.entries };
  }
  const entries = MOVED_ENTRIES.filter((name) => fs.existsSync(path.join(legacyRoot, name)));
  for (const name of entries) if (isFilledDirectory(path.join(appDataRoot, name))) throw conflict(path.join(appDataRoot, name));
  const pending: Marker = { status: 'switching', entries, from: legacyRoot, at: new Date().toISOString() };
  if (entries.length === 0) {
    writeMarker(markerFile, { ...pending, status: 'complete' });
    return { migrated: false };
  }
  stageCopies(resolved, entries);
  writeMarker(markerFile, pending);
  switchOver(resolved, pending, markerFile);
  return { migrated: true, from: legacyRoot, to: appDataRoot, entries };
}
