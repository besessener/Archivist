import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/harness';

describe('backups: retention, size and archive above the data directory (issue #67)', () => {
  it('keeps only the newest `backups.keep` backups, separately for metadata and full backups', async () => {
    const app = await createTestApp({ configured: false });
    await app.ok('settings:update', { backups: { keep: 2 } });
    const meta: BackupInfo[] = [];
    for (let i = 0; i < 4; i++) meta.push(await app.ok('backup:create', { includeArchive: false }));
    const full: BackupInfo[] = [];
    for (let i = 0; i < 3; i++) full.push(await app.ok('backup:create', { includeArchive: true }));

    const list = await app.ok('backup:list', {});
    const names = (kind: 'metadata' | 'full') => list.filter((b) => b.kind === kind).map((b) => b.name);
    expect(names('metadata')).toEqual([meta[3]!.name, meta[2]!.name]);
    expect(names('full')).toEqual([full[2]!.name, full[1]!.name]);
    for (const b of [meta[0]!, meta[1]!, full[0]!]) expect(fs.existsSync(b.path), b.name).toBe(false);

    // pruning is recorded in the audit log
    const audit = await app.ok('audit:list', {});
    expect(audit.some((a) => a.action === 'backup.prune' && a.paths.includes(meta[0]!.path))).toBe(true);

    // lowering `keep` takes effect with the next backup of that kind only
    await app.ok('settings:update', { backups: { keep: 1 } });
    const latest = await app.ok('backup:create', { includeArchive: false });
    const after = await app.ok('backup:list', {});
    expect(after.filter((b) => b.kind === 'metadata').map((b) => b.name)).toEqual([latest.name]);
    expect(after.filter((b) => b.kind === 'full')).toHaveLength(2);
    await app.cleanup();
  });

  it('does not touch folders in the backups directory that are not backups', async () => {
    const app = await createTestApp({ configured: false });
    await app.ok('settings:update', { backups: { keep: 1 } });
    const foreign = path.join(app.services.paths.backups, 'eigene-ablage');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'notiz.txt'), 'x');
    await app.ok('backup:create', { includeArchive: false });
    await app.ok('backup:create', { includeArchive: false });
    expect(fs.existsSync(path.join(foreign, 'notiz.txt'))).toBe(true);
    expect(await app.ok('backup:list', {})).toHaveLength(1);
    await app.cleanup();
  });

  it('computes the size of a full backup recursively', async () => {
    const app = await createTestApp({ configured: false });
    const archive = app.services.settings.get().archiveRoot;
    fs.mkdirSync(path.join(archive, 'work', 'deep', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(archive, 'work', 'deep', 'deeper', 'big.bin'), Buffer.alloc(200_000, 1));
    const full = await app.ok('backup:create', { includeArchive: true });
    const topLevelFiles = fs
      .readdirSync(full.path, { withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((sum, e) => sum + fs.statSync(path.join(full.path, e.name)).size, 0);
    expect(full.sizeBytes).toBeGreaterThanOrEqual(topLevelFiles + 200_000);
    const listed = (await app.ok('backup:list', {})).find((b) => b.name === full.name)!;
    expect(listed.sizeBytes).toBe(full.sizeBytes);
    await app.cleanup();
  });

  it('backs up an archive that lies above the data directory without copying itself', async () => {
    const app = await createTestApp({ configured: false });
    // the data directory is <root>/Archivist, so <root> is a parent of it
    await app.ok('settings:update', { archiveRoot: app.root });
    fs.mkdirSync(path.join(app.root, 'work'), { recursive: true });
    fs.writeFileSync(path.join(app.root, 'work', 'vertrag.txt'), 'Vertrag');
    const first = await app.ok('backup:create', { includeArchive: true });
    const second = await app.ok('backup:create', { includeArchive: true });
    for (const b of [first, second]) {
      const copied = path.join(b.path, 'archive');
      expect(fs.readFileSync(path.join(copied, 'work', 'vertrag.txt'), 'utf8')).toBe('Vertrag');
      expect(fs.readdirSync(copied)).not.toContain('Archivist');
    }
    await app.cleanup();
  });

  it('backs up an archive that is the data directory itself without copying the backups folder', async () => {
    const app = await createTestApp({ configured: false });
    await app.ok('settings:update', { archiveRoot: app.services.paths.root });
    fs.mkdirSync(path.join(app.services.paths.root, 'work'), { recursive: true });
    fs.writeFileSync(path.join(app.services.paths.root, 'work', 'a.txt'), 'A');
    await app.ok('backup:create', { includeArchive: true });
    const b = await app.ok('backup:create', { includeArchive: true });
    const copied = fs.readdirSync(path.join(b.path, 'archive'));
    expect(copied).toContain('work');
    expect(copied).not.toContain('backups');
    await app.cleanup();
  });
});
