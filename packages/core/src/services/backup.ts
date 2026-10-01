import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo } from '@archivist/shared';
import type { AppContext } from '../context';
import { fsError } from '../util/errors';
import { isInside } from '../util/paths';
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

/**
 * Copies `src` to `dest` like `fsp.cp`, but leaves out every path in `excluded`.
 * Only directories that contain an excluded path are walked by hand; everything else is copied by `fsp.cp`,
 * so `fsp.cp` never sees a destination inside its own source (which it refuses).
 */
async function copyTreeExcluding(src: string, dest: string, excluded: string[]): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (excluded.some((x) => isInside(x, from))) continue;
    if (e.isDirectory() && excluded.some((x) => isInside(from, x))) await copyTreeExcluding(from, to, excluded);
    else await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  }
}

/** Descending order by plain code-unit comparison (ISO timestamps and backup names sort correctly this way). */
function cmpDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

async function realpathOrSelf(p: string): Promise<string> {
  return fsp.realpath(p).catch(() => path.resolve(p));
}

/**
 * Backups: konsistenter SQLite-Snapshot über die Online-Backup-API (nicht per Dateikopie) plus Konfiguration.
 * Der verschlüsselte API-Key wird nie gesichert. „Metadaten-Backup“ und „vollständiges Archiv-Backup“ sind getrennt.
 * After each backup, only the newest `backups.keep` backups of the same kind are kept.
 */
export class BackupService {
  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async create(includeArchive: boolean, trigger: 'manual' | 'startup' = 'manual'): Promise<BackupInfo> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const base = `${includeArchive ? 'vollstaendig' : 'metadaten'}-${stamp}`;
    await fsp.mkdir(this.ctx.paths.backups, { recursive: true });
    const { name, dir } = await this.reserveDir(base);
    try {
      await this.ctx.database.backupTo(path.join(dir, 'archivist.db'));
      const cfg = this.settings.get();
      await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify(cfg, null, 2), 'utf8'); // enthält keinen API-Key
      await fsp.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify(
          {
            kind: includeArchive ? 'full' : 'metadata',
            createdAt: new Date().toISOString(),
            archiveRoot: cfg.archiveRoot,
            note: 'Enthält Datenbank (inkl. Wissensgraph, Kategorien, Beziehungen, Audit Log) und Einstellungen ohne API-Key.',
          },
          null,
          2,
        ),
        'utf8',
      );
      if (includeArchive && fs.existsSync(cfg.archiveRoot)) await this.copyArchive(cfg.archiveRoot, path.join(dir, 'archive'));
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw fsError('Das Backup ist fehlgeschlagen.', err);
    }
    this.audit.log({ action: 'backup.create', actor: 'user', trigger, confirmed: true, paths: [dir], after: { includeArchive } });
    await this.applyRetention(includeArchive ? 'full' : 'metadata', name);
    return this.info(name);
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
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw fsError('Das Backup ist fehlgeschlagen.', err);
      }
    }
  }

  /**
   * Copies the archive into the backup. If the archive lies above the data directory, the data directory
   * (with its backups, database files and logs) is not part of the archive and is skipped; the backups folder
   * is always skipped. This prevents the backup from copying itself.
   */
  private async copyArchive(archiveRoot: string, dest: string): Promise<void> {
    const src = await realpathOrSelf(archiveRoot);
    const dataRoot = await realpathOrSelf(this.ctx.paths.root);
    const excluded = [await realpathOrSelf(this.ctx.paths.backups)];
    if (!isInside(dataRoot, src)) excluded.push(dataRoot);
    if (excluded.some((x) => isInside(src, x))) await copyTreeExcluding(src, dest, excluded);
    else await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
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
        this.ctx.logger.warn('backup', 'Altes Backup konnte nicht entfernt werden', { path: b.path, error: err });
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
        /* kein gültiges Backup */
      }
    }
    return out.sort((a, b) => cmpDesc(a.createdAt, b.createdAt) || cmpDesc(a.name, b.name));
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
