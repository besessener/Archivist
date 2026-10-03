import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo, Settings } from '@archivist/shared';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { AppError, fsError } from '../util/errors';
import { isInside } from '../util/paths';
import type { ArchiveService } from './archive';
import type { AuditService } from './audit';
import type { SettingsService } from './settings';

type BackupKind = BackupInfo['kind'];

/** Total size of all files below `dir` (recursive; symlinks are counted by their own size, not followed). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(full) : (await fsp.lstat(full)).size;
  }
  return total;
}

/** Copies like `fsp.cp` but leaves out `excluded`; folders holding an excluded path are walked by hand (`fsp.cp` refuses a destination inside its source). */
async function copyTreeExcluding(tree: { source: string; dest: string }, excluded: string[]): Promise<void> {
  await fsp.mkdir(tree.dest, { recursive: true });
  for (const e of await fsp.readdir(tree.source, { withFileTypes: true })) {
    const from = path.join(tree.source, e.name);
    const to = path.join(tree.dest, e.name);
    if (excluded.some((x) => isInside(x, from))) continue;
    if (e.isDirectory() && excluded.some((x) => isInside(from, x))) await copyTreeExcluding({ source: from, dest: to }, excluded);
    else await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  }
}

/** Number of regular files below `dir` (recursive). */
async function fileCount(dir: string): Promise<number> {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) n += e.isDirectory() ? await fileCount(path.join(dir, e.name)) : 1;
  return n;
}

/** Descending order by plain code-unit comparison (ISO timestamps and backup names sort correctly this way). */
function compareDescending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

async function realpathOrSelf(p: string): Promise<string> {
  return fsp.realpath(p).catch(() => path.resolve(p));
}

export interface BackupServiceDeps {
  ctx: AppContext;
  settings: SettingsService;
  audit: AuditService;
  archive: ArchiveService;
}

/** Backups: SQLite snapshot via the online backup API plus settings (never the API key), optionally the archive; retention per kind. */
export class BackupService {
  private readonly ctx: AppContext;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;
  private readonly archive: ArchiveService;

  constructor(deps: BackupServiceDeps) {
    ({ ctx: this.ctx, settings: this.settings, audit: this.audit, archive: this.archive } = deps);
  }

  /** Creates a backup; the manifest is written last, so an interrupted backup never counts and never pushes a complete one out. */
  async create({ includeArchive, trigger = 'manual' }: { includeArchive: boolean; trigger?: 'manual' | 'startup' }): Promise<BackupInfo> {
    const current = this.settings.get();
    if (includeArchive) await this.assertArchiveReachable(current.archiveRoot);
    // archive file operations are blocked while the archive is copied, so the database snapshot matches the files
    const release = includeArchive ? this.archive.beginBackup() : () => undefined;
    let written: { name: string; dir: string; archiveFiles: number | null };
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
      await fsp.mkdir(this.ctx.paths.backups, { recursive: true });
      const { name, dir } = await this.reserveDir(`${includeArchive ? 'vollstaendig' : 'metadaten'}-${stamp}`);
      written = { name, dir, archiveFiles: await this.writeBackup(dir, { settings: current, includeArchive }) };
    } finally {
      release();
    }
    const { name, dir, archiveFiles } = written;
    this.audit.log({
      action: 'backup.create',
      actor: 'user',
      trigger,
      confirmed: true,
      paths: [dir],
      after: { includeArchive, ...(archiveFiles === null ? {} : { archiveFiles }) },
    });
    await this.applyRetention(includeArchive ? 'full' : 'metadata', name);
    return this.info(name);
  }

  /** Writes database, settings, archive copy and manifest into `dir`; on failure `dir` is removed. Returns the archive file count. */
  private async writeBackup(dir: string, content: { settings: Settings; includeArchive: boolean }): Promise<number | null> {
    const { settings, includeArchive } = content;
    let archiveFiles: number | null = null;
    try {
      await this.ctx.database.backupTo(path.join(dir, 'archivist.db'));
      await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8'); // contains no API key
      if (includeArchive) {
        const dest = path.join(dir, 'archive');
        await this.copyArchive(settings.archiveRoot, dest);
        archiveFiles = await fileCount(dest);
      }
      const manifest = {
        kind: includeArchive ? 'full' : 'metadata',
        createdAt: new Date().toISOString(),
        archiveRoot: settings.archiveRoot,
        ...(archiveFiles === null ? {} : { archiveFiles }),
        note: 'Enthält Datenbank (inkl. Wissensgraph, Kategorien, Beziehungen, Audit Log) und Einstellungen ohne API-Key.',
      };
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      return archiveFiles;
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw fsError('Das Backup ist fehlgeschlagen.', { cause: err });
    }
  }

  /** A full backup needs the archive: one without documents (unplugged drive, empty folder) would push good ones out of retention. */
  private async assertArchiveReachable(archiveRoot: string): Promise<void> {
    const stat = await fsp.stat(archiveRoot).catch(() => null);
    if (!stat?.isDirectory())
      throw new AppError(
        'filesystem_error',
        `Das vollständige Backup ist fehlgeschlagen: Der Archivordner ${archiveRoot} ist nicht erreichbar. Ältere Backups bleiben erhalten.`,
        {
          retryable: true,
        },
      );
    const archived =
      this.ctx.database.db
        .select({ n: count() })
        .from(documents)
        .where(and(eq(documents.status, 'archived'), isNotNull(documents.archiveRelPath)))
        .get()?.n ?? 0;
    if (archived > 0 && (await fsp.readdir(archiveRoot)).length === 0)
      throw new AppError(
        'filesystem_error',
        `Das vollständige Backup ist fehlgeschlagen: Der Archivordner ${archiveRoot} ist leer, obwohl ${archived} Dokument(e) archiviert sind. Ältere Backups bleiben erhalten.`,
        { retryable: true },
      );
  }

  /** Creates a fresh, not yet existing backup directory (never reuses one, so a failure cannot remove an older backup). */
  private async reserveDir(base: string): Promise<{ name: string; dir: string }> {
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      const dir = path.join(this.ctx.paths.backups, name);
      try {
        await fsp.mkdir(dir);
        return { name, dir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw fsError('Das Backup ist fehlgeschlagen.', { cause: err });
      }
    }
  }

  /** Copies the archive into the backup, never the backups folder or (when the archive lies above it) the data directory. */
  private async copyArchive(archiveRoot: string, dest: string): Promise<void> {
    const source = await realpathOrSelf(archiveRoot);
    const dataRoot = await realpathOrSelf(this.ctx.paths.root);
    const excluded = [await realpathOrSelf(this.ctx.paths.backups)];
    if (!isInside(dataRoot, source)) excluded.push(dataRoot);
    if (excluded.some((x) => isInside(source, x))) await copyTreeExcluding({ source, dest }, excluded);
    else await fsp.cp(source, dest, { recursive: true, errorOnExist: true, force: false });
  }

  /** Removes the oldest backups of `kind` beyond `backups.keep`. Never removes `current`; failures are only logged. */
  private async applyRetention(kind: BackupKind, current: string): Promise<void> {
    const keep = Math.max(1, this.settings.get().backups.keep);
    const sameKind = (await this.entries()).filter((b) => b.kind === kind && b.name !== current);
    const removed: string[] = [];
    for (const b of sameKind.slice(Math.max(0, keep - 1))) {
      try {
        await fsp.rm(b.path, { recursive: true, force: true });
        removed.push(b.path);
      } catch (err) {
        this.ctx.logger.warn('backup', 'Could not remove old backup', { path: b.path, error: err });
      }
    }
    if (removed.length > 0)
      this.audit.log({ action: 'backup.prune', actor: 'user', trigger: 'retention', confirmed: true, paths: removed, after: { kind, keep } });
  }

  private async readManifest(name: string): Promise<Omit<BackupInfo, 'sizeBytes'>> {
    const dir = path.join(this.ctx.paths.backups, name);
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as { kind: BackupKind; createdAt: string };
    return { name, path: dir, kind: manifest.kind, createdAt: manifest.createdAt };
  }

  private async info(name: string): Promise<BackupInfo> {
    const m = await this.readManifest(name);
    return { ...m, sizeBytes: await dirSize(m.path) };
  }

  /** Valid backups (with a readable manifest) without sizes, newest first. */
  private async entries(): Promise<Omit<BackupInfo, 'sizeBytes'>[]> {
    const out: Omit<BackupInfo, 'sizeBytes'>[] = [];
    for (const e of await fsp.readdir(this.ctx.paths.backups, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      try {
        out.push(await this.readManifest(e.name));
      } catch {
        /* not a valid backup */
      }
    }
    return out.sort((a, b) => compareDescending(a.createdAt, b.createdAt) || compareDescending(a.name, b.name));
  }

  /** All valid backups with their total (recursive) size, newest first. */
  async list(): Promise<BackupInfo[]> {
    const sized = await Promise.all(
      (await this.entries()).map(async (b) => {
        try {
          return { ...b, sizeBytes: await dirSize(b.path) };
        } catch {
          return null; // removed while listing
        }
      }),
    );
    return sized.filter((b): b is BackupInfo => b !== null);
  }
}
