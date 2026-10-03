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
    fs.mkdirSync(path.join(archive, 'Arbeit', 'deep', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(archive, 'Arbeit', 'deep', 'deeper', 'big.bin'), Buffer.alloc(200_000, 1));
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
    fs.mkdirSync(path.join(app.root, 'Arbeit'), { recursive: true });
    fs.writeFileSync(path.join(app.root, 'Arbeit', 'vertrag.txt'), 'Vertrag');
    const first = await app.ok('backup:create', { includeArchive: true });
    const second = await app.ok('backup:create', { includeArchive: true });
    for (const b of [first, second]) {
      const copied = path.join(b.path, 'archive');
      expect(fs.readFileSync(path.join(copied, 'Arbeit', 'vertrag.txt'), 'utf8')).toBe('Vertrag');
      expect(fs.readdirSync(copied)).not.toContain('Archivist');
    }
    await app.cleanup();
  });

  it('backs up an archive that is the data directory itself without copying the backups folder', async () => {
    const app = await createTestApp({ configured: false });
    await app.ok('settings:update', { archiveRoot: app.services.paths.root });
    fs.mkdirSync(path.join(app.services.paths.root, 'Arbeit'), { recursive: true });
    fs.writeFileSync(path.join(app.services.paths.root, 'Arbeit', 'a.txt'), 'A');
    await app.ok('backup:create', { includeArchive: true });
    const b = await app.ok('backup:create', { includeArchive: true });
    const copied = fs.readdirSync(path.join(b.path, 'archive'));
    expect(copied).toContain('Arbeit');
    expect(copied).not.toContain('backups');
    await app.cleanup();
  });
});

describe('backups: a full backup needs the archive (issue #236)', () => {
  it('fails without pruning when the archive folder is unreachable, and keeps the good full backups', async () => {
    const app = await createTestApp({ configured: false });
    await app.ok('settings:update', { backups: { keep: 2 } });
    const archive = app.services.settings.get().archiveRoot;
    fs.mkdirSync(path.join(archive, 'Arbeit'), { recursive: true });
    fs.writeFileSync(path.join(archive, 'Arbeit', 'vertrag.txt'), 'Vertrag');
    const good = [await app.ok('backup:create', { includeArchive: true }), await app.ok('backup:create', { includeArchive: true })];

    // the archive drive is gone
    fs.rmSync(archive, { recursive: true, force: true });
    for (let i = 0; i < 2; i++) {
      const r = await app.call('backup:create', { includeArchive: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/Archivordner .* nicht erreichbar/);
    }
    const list = await app.ok('backup:list', {});
    expect(list.map((b) => b.name)).toEqual([good[1]!.name, good[0]!.name]);
    for (const b of good) expect(fs.readFileSync(path.join(b.path, 'archive', 'Arbeit', 'vertrag.txt'), 'utf8')).toBe('Vertrag');
    const audit = await app.ok('audit:list', {});
    expect(audit.filter((a) => a.action === 'backup.create')).toHaveLength(2);
    expect(audit.some((a) => a.action === 'backup.prune')).toBe(false);

    // a metadata backup still works without the archive
    expect((await app.ok('backup:create', { includeArchive: false })).kind).toBe('metadata');
    await app.cleanup();
  });

  it('fails when the archive folder is empty although documents are archived', async () => {
    const app = await createTestApp({ configured: false });
    const archive = app.services.settings.get().archiveRoot;
    fs.mkdirSync(archive, { recursive: true });
    // an empty archive on a fresh installation is fine
    expect((await app.ok('backup:create', { includeArchive: true })).kind).toBe('full');

    const imp = await app.ok('documents:import', { paths: [app.file('in/a.txt', 'Inhalt')] });
    await app.services.jobs.whenIdle();
    app.services.database.sqlite.prepare("UPDATE documents SET status = 'archived', archive_rel_path = 'Arbeit/a.txt' WHERE id = ?").run(imp.imported[0]!.id);
    const r = await app.call('backup:create', { includeArchive: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/leer, obwohl 1 Dokument\(e\) archiviert sind/);
    expect(await app.ok('backup:list', {})).toHaveLength(1);
    await app.cleanup();
  });

  it('writes the manifest last with the number of copied files; a backup without manifest never counts', async () => {
    const app = await createTestApp({ configured: false });
    await app.ok('settings:update', { backups: { keep: 1 } });
    const archive = app.services.settings.get().archiveRoot;
    fs.mkdirSync(path.join(archive, 'Arbeit', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(archive, 'Arbeit', 'a.txt'), 'A');
    fs.writeFileSync(path.join(archive, 'Arbeit', 'sub', 'b.txt'), 'B');
    const full = await app.ok('backup:create', { includeArchive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(full.path, 'manifest.json'), 'utf8')) as { archiveFiles: number };
    expect(manifest.archiveFiles).toBe(2);

    // a backup interrupted by a crash during the archive copy: database and archive folder, but no manifest
    const interrupted = path.join(app.services.paths.backups, 'vollstaendig-2999-01-01T00-00-00-000');
    fs.mkdirSync(path.join(interrupted, 'archive'), { recursive: true });
    fs.copyFileSync(path.join(full.path, 'archivist.db'), path.join(interrupted, 'archivist.db'));
    expect((await app.ok('backup:list', {})).map((b) => b.name)).toEqual([full.name]);
    await app.cleanup();
  });

  it('blocks archive file operations while the archive is copied', async () => {
    const app = await createTestApp({ configured: false });
    const release = app.services.archive.beginBackup();
    expect(() => app.services.archive.beginBackup()).toThrow(/bereits ein vollständiges Backup/);
    expect(() => app.services.archive.beginRootChange()).toThrow(/vollständiges Backup/);
    const r = await app.call('backup:create', { includeArchive: true });
    expect(r.ok).toBe(false);
    release();
    fs.mkdirSync(app.services.settings.get().archiveRoot, { recursive: true });
    expect((await app.ok('backup:create', { includeArchive: true })).kind).toBe('full');
    // released again after the backup
    app.services.archive.beginRootChange()();
    await app.cleanup();
  });
});
