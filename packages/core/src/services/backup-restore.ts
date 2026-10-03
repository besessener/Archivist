import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppError, validationError } from '../util/errors';

const MARKER_FILE = 'restore-pending.json';
const DATABASE_FILE = 'archivist.db';
const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`];
const PRE_MIGRATION_PREFIX = 'vor-migration-';
const NOT_SET_ASIDE =
  'Die geplante Wiederherstellung wurde nicht ausgeführt: Die bisherige Datenbank ließ sich nicht beiseitelegen (z. B. weil eine Datei gerade geöffnet ist). Deine Daten sind unverändert.';

export interface RestoreSource {
  name: string;
  databaseFile: string;
  createdAt: string;
  /** Archive copy of a full backup and the folder it was taken from. */
  archive: { dir: string; root: string } | null;
}

export interface RestorePaths {
  /** Folder of the restore marker. */
  appData: string;
  database: string;
  backups: string;
}

export interface RestoreReport {
  restoredFrom: string;
  previousDatabase: string;
}

const compareNewestFirst = (a: RestoreSource, b: RestoreSource) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name);

function readBackupDir(backups: string, name: string): RestoreSource | null {
  const dir = path.join(backups, name);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { createdAt: string; archiveRoot?: string };
    const databaseFile = path.join(dir, DATABASE_FILE);
    if (!fs.statSync(databaseFile).isFile()) return null;
    const archiveDir = path.join(dir, 'archive');
    const hasArchive = manifest.archiveRoot && fs.existsSync(archiveDir);
    return { name, databaseFile, createdAt: manifest.createdAt, archive: hasArchive ? { dir: archiveDir, root: manifest.archiveRoot! } : null };
  } catch {
    return null;
  }
}

/** Backups (folders with a manifest) and the snapshots taken before migrations, newest first. */
export function restoreSources(backups: string): RestoreSource[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backups, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources: RestoreSource[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const source = readBackupDir(backups, entry.name);
      if (source) sources.push(source);
    } else if (entry.isFile() && entry.name.startsWith(PRE_MIGRATION_PREFIX) && entry.name.endsWith('.db')) {
      const databaseFile = path.join(backups, entry.name);
      sources.push({ name: entry.name, databaseFile, createdAt: fs.statSync(databaseFile).mtime.toISOString(), archive: null });
    }
  }
  return sources.toSorted(compareNewestFirst);
}

/** The newest source whose database passes the structural check (for the recovery after a damaged database). */
export function newestIntactSource(backups: string): RestoreSource | null {
  return restoreSources(backups).find((source) => isIntact(source.databaseFile)) ?? null;
}

function isIntact(databaseFile: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(databaseFile, { readonly: true, fileMustExist: true });
    return db.pragma('quick_check(1)', { simple: true }) === 'ok';
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Marks a restore for the next start (the database cannot be swapped while it is open). */
export function scheduleRestore(paths: RestorePaths, name: string): void {
  const source = restoreSources(paths.backups).find((candidate) => candidate.name === name);
  if (!source) throw validationError('Dieses Backup gibt es nicht (mehr).');
  if (!isIntact(source.databaseFile))
    throw new AppError('database_corrupt', 'Dieses Backup ist selbst beschädigt und kann nicht wiederhergestellt werden. Nimm ein anderes.', {
      details: source.databaseFile,
    });
  fs.writeFileSync(path.join(paths.appData, MARKER_FILE), JSON.stringify({ name, requestedAt: new Date().toISOString() }), 'utf8');
}

function readMarker(file: string): string | null {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown };
    return typeof marker.name === 'string' ? marker.name : null;
  } catch {
    return null;
  }
}

/** Moves the database files aside, all or none of them; returns the folder holding them. */
function moveDatabaseAside(databaseDir: string): string {
  const aside = path.join(databaseDir, `vor-wiederherstellung-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}`);
  fs.mkdirSync(aside, { recursive: true });
  const moved: string[] = [];
  try {
    for (const name of DATABASE_FILES) {
      if (!fs.existsSync(path.join(databaseDir, name))) continue;
      fs.renameSync(path.join(databaseDir, name), path.join(aside, name));
      moved.push(name);
    }
  } catch (err) {
    for (const name of moved) fs.renameSync(path.join(aside, name), path.join(databaseDir, name));
    fs.rmSync(aside, { recursive: true, force: true });
    throw new AppError('filesystem_error', NOT_SET_ASIDE, { cause: err });
  }
  return aside;
}

function moveDatabaseBack(databaseDir: string, aside: string): void {
  for (const name of DATABASE_FILES) {
    const file = path.join(aside, name);
    if (fs.existsSync(file)) fs.renameSync(file, path.join(databaseDir, name));
  }
}

/**
 * Applies a scheduled restore before the database is opened: the current database is kept next to it, the backup's
 * database takes its place, and the archive files of a full backup that are missing come back (nothing is overwritten).
 * Returns null when nothing was scheduled; the marker is removed in every case so a failure cannot loop.
 */
export function applyPendingRestore(paths: RestorePaths, archiveRoot: string): RestoreReport | null {
  const markerFile = path.join(paths.appData, MARKER_FILE);
  if (!fs.existsSync(markerFile)) return null;
  const name = readMarker(markerFile);
  fs.rmSync(markerFile, { force: true });
  const source = name ? restoreSources(paths.backups).find((candidate) => candidate.name === name) : undefined;
  if (!source || !isIntact(source.databaseFile))
    throw new AppError(
      'database_error',
      'Die geplante Wiederherstellung wurde nicht ausgeführt: Das Backup fehlt oder ist beschädigt. Deine Daten sind unverändert.',
    );
  const previousDatabase = moveDatabaseAside(paths.database);
  const target = path.join(paths.database, DATABASE_FILE);
  try {
    fs.copyFileSync(source.databaseFile, `${target}.restoring`);
    fs.renameSync(`${target}.restoring`, target);
  } catch (err) {
    fs.rmSync(`${target}.restoring`, { force: true });
    moveDatabaseBack(paths.database, previousDatabase);
    throw new AppError('filesystem_error', 'Die Wiederherstellung ist fehlgeschlagen; die bisherige Datenbank wurde wieder eingesetzt.', { cause: err });
  }
  if (source.archive && path.resolve(source.archive.root) === path.resolve(archiveRoot))
    fs.cpSync(source.archive.dir, archiveRoot, { recursive: true, force: false, errorOnExist: false });
  return { restoredFrom: source.name, previousDatabase };
}
