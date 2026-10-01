import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo } from '@archivist/shared';
import type { AppContext } from '../context';
import { fsError } from '../util/errors';
import type { AuditService } from './audit';
import type { SettingsService } from './settings';

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(full) : (await fsp.stat(full)).size;
  }
  return total;
}

/**
 * Backups: konsistenter SQLite-Snapshot über die Online-Backup-API (nicht per Dateikopie) plus Konfiguration.
 * Der verschlüsselte API-Key wird nie gesichert. „Metadaten-Backup“ und „vollständiges Archiv-Backup“ sind getrennt.
 */
export class BackupService {
  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async create(includeArchive: boolean): Promise<BackupInfo> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${includeArchive ? 'vollstaendig' : 'metadaten'}-${stamp}`;
    const dir = path.join(this.ctx.paths.backups, name);
    try {
      await fsp.mkdir(dir, { recursive: true });
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
      if (includeArchive && fs.existsSync(cfg.archiveRoot))
        await fsp.cp(cfg.archiveRoot, path.join(dir, 'archive'), { recursive: true, errorOnExist: true, force: false });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw fsError('Das Backup ist fehlgeschlagen.', err);
    }
    this.audit.log({ action: 'backup.create', actor: 'user', trigger: 'manual', confirmed: true, paths: [dir], after: { includeArchive } });
    return this.info(name);
  }

  private async infoAsync(name: string): Promise<BackupInfo> {
    const dir = path.join(this.ctx.paths.backups, name);
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as { kind: 'metadata' | 'full'; createdAt: string };
    return { name, path: dir, kind: manifest.kind, createdAt: manifest.createdAt, sizeBytes: await dirSize(dir) };
  }

  private info(name: string): BackupInfo {
    const dir = path.join(this.ctx.paths.backups, name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { kind: 'metadata' | 'full'; createdAt: string };
    const size = fs.readdirSync(dir).reduce((a, f) => a + (fs.statSync(path.join(dir, f)).isFile() ? fs.statSync(path.join(dir, f)).size : 0), 0);
    return { name, path: dir, kind: manifest.kind, createdAt: manifest.createdAt, sizeBytes: size };
  }

  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    for (const e of await fsp.readdir(this.ctx.paths.backups, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      try {
        out.push(await this.infoAsync(e.name));
      } catch {
        /* kein gültiges Backup */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
