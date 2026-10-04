import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppError, toErrorInfo, validationError } from '../util/errors';

const MARKER_FILE = 'restore-pending.json';
const DATABASE_FILE = 'archivist.db';
const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`];
const PRE_MIGRATION_PREFIX = 'vor-migration-';
const ASIDE_PREFIX = 'vor-wiederherstellung-';
const ASIDE_NAME = /^vor-wiederherstellung-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/;
const NOT_SET_ASIDE =
  'Die geplante Wiederherstellung wurde nicht ausgeführt: Die bisherige Datenbank ließ sich nicht beiseitelegen (z. B. weil eine Datei gerade geöffnet ist). Deine Daten sind unverändert.';

export interface RestoreSource {
  name: string;
  /** The backup folder, the aside folder, or the pre-migration file. */
  path: string;
  databaseFile: string;
  /** Write-ahead log that belongs to the database (only an aside database can have one). */
  walFile: string | null;
  createdAt: string;
  kind: 'backup' | 'before_restore';
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
    return {
      name,
      path: dir,
      databaseFile,
      walFile: null,
      createdAt: manifest.createdAt,
      kind: 'backup',
      archive: hasArchive ? { dir: archiveDir, root: manifest.archiveRoot! } : null,
    };
  } catch {
    return null;
  }
}

function backupSources(backups: string): RestoreSource[] {
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
      const createdAt = fs.statSync(databaseFile).mtime.toISOString();
      sources.push({ name: entry.name, path: databaseFile, databaseFile, walFile: null, createdAt, kind: 'backup', archive: null });
    }
  }
  return sources;
}

/** The databases a restore set aside (`database/vor-wiederherstellung-<time>/`); the time in the name is when the restore happened. */
function asideSources(databaseDir: string): RestoreSource[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(databaseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources: RestoreSource[] = [];
  for (const entry of entries) {
    const stamp = entry.isDirectory() ? ASIDE_NAME.exec(entry.name) : null;
    if (!stamp) continue;
    const dir = path.join(databaseDir, entry.name);
    const databaseFile = path.join(dir, DATABASE_FILE);
    if (!fs.existsSync(databaseFile)) continue;
    const walFile = path.join(dir, `${DATABASE_FILE}-wal`);
    const createdAt = `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`;
    sources.push({
      name: entry.name,
      path: dir,
      databaseFile,
      walFile: fs.existsSync(walFile) ? walFile : null,
      createdAt,
      kind: 'before_restore',
      archive: null,
    });
  }
  return sources;
}

/** Backups (folders with a manifest), the snapshots taken before migrations and the databases set aside by restores, newest first. */
export function restoreSources(paths: Pick<RestorePaths, 'backups' | 'database'>): RestoreSource[] {
  return [...backupSources(paths.backups), ...asideSources(paths.database)].toSorted(compareNewestFirst);
}

/** The newest backup whose database passes the structural check (for the recovery after a damaged database). */
export function newestIntactSource(paths: RestorePaths): RestoreSource | null {
  const target = path.join(paths.database, DATABASE_FILE);
  return (
    backupSources(paths.backups)
      .toSorted(compareNewestFirst)
      .find((source) => stagedIntact(source, target)) ?? null
  );
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

const stagedFiles = (target: string) => [`${target}.restoring`, `${target}.restoring-wal`, `${target}.restoring-shm`];

function discardStaged(target: string): void {
  for (const file of stagedFiles(target)) fs.rmSync(file, { force: true });
}

/** Copies the source's database (and log) next to `target`, so checking it never touches the original. */
function stage(source: RestoreSource, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  discardStaged(target);
  fs.copyFileSync(source.databaseFile, `${target}.restoring`);
  if (source.walFile) fs.copyFileSync(source.walFile, `${target}.restoring-wal`);
}

/** Stages the source and checks the copy; the staged files stay only when it is intact. A copy that fails is a disk problem, not damage. */
function stageIntact(source: RestoreSource, target: string): boolean {
  try {
    stage(source, target);
  } catch (err) {
    discardStaged(target);
    const info = toErrorInfo(err);
    throw new AppError('filesystem_error', `Das Backup ließ sich zur Prüfung nicht kopieren: ${info.message} Deine Daten sind unverändert.`, {
      retryable: info.retryable,
      details: info.details,
      cause: err,
    });
  }
  if (isIntact(`${target}.restoring`)) {
    // the read-only check of a WAL database leaves an empty log and index behind; only a copied log belongs to the restore
    fs.rmSync(`${target}.restoring-shm`, { force: true });
    if (!source.walFile) fs.rmSync(`${target}.restoring-wal`, { force: true });
    return true;
  }
  discardStaged(target);
  return false;
}

function stagedIntact(source: RestoreSource, target: string): boolean {
  const intact = stageIntact(source, target);
  discardStaged(target);
  return intact;
}

export function findRestoreSource(paths: RestorePaths, name: string): RestoreSource | undefined {
  return restoreSources(paths).find((candidate) => candidate.name === name);
}

/** Marks a restore for the next start (the database cannot be swapped while it is open). */
export function scheduleRestore(paths: RestorePaths, name: string): void {
  const source = findRestoreSource(paths, name);
  if (!source) throw validationError('Dieses Backup gibt es nicht (mehr).');
  if (!stagedIntact(source, path.join(paths.database, DATABASE_FILE)))
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
  const aside = path.join(databaseDir, `${ASIDE_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}`);
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
  const source = name ? findRestoreSource(paths, name) : undefined;
  const target = path.join(paths.database, DATABASE_FILE);
  if (!source || !stageIntact(source, target))
    throw new AppError(
      'database_error',
      'Die geplante Wiederherstellung wurde nicht ausgeführt: Das Backup fehlt oder ist beschädigt. Deine Daten sind unverändert.',
    );
  let previousDatabase: string;
  try {
    previousDatabase = moveDatabaseAside(paths.database);
  } catch (err) {
    discardStaged(target);
    throw err;
  }
  try {
    fs.renameSync(`${target}.restoring`, target);
    if (source.walFile) fs.renameSync(`${target}.restoring-wal`, `${target}-wal`);
  } catch (err) {
    discardStaged(target);
    for (const file of [target, `${target}-wal`]) fs.rmSync(file, { force: true });
    moveDatabaseBack(paths.database, previousDatabase);
    throw new AppError('filesystem_error', 'Die Wiederherstellung ist fehlgeschlagen; die bisherige Datenbank wurde wieder eingesetzt.', { cause: err });
  }
  if (source.archive && path.resolve(source.archive.root) === path.resolve(archiveRoot))
    fs.cpSync(source.archive.dir, archiveRoot, { recursive: true, force: false, errorOnExist: false });
  return { restoredFrom: source.name, previousDatabase };
}
