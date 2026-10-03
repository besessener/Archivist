import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDataPaths } from '../../packages/core/src/context';
import { applyPendingRestore, newestIntactSource, scheduleRestore } from '../../packages/core/src/services/backup-restore';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

// Restoring a backup takes effect on the next start; the replaced database stays next to it (#217).

let root: string;
const apps: TestApp[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-restore-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.services.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

async function startApp(): Promise<TestApp> {
  const app = await createTestApp({ dataRoot: root, privacy: 'auto' });
  apps.push(app);
  return app;
}

async function restart(app: TestApp): Promise<TestApp> {
  await app.services.shutdown();
  apps.splice(apps.indexOf(app), 1);
  return startApp();
}

async function archived(app: TestApp, name: string, content: string): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: 'Privat/belege', mainTopic: null }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const res = await app.ok('documents:archive', {
    items: [{ documentId: imp.imported[0]!.id, mode: 'copy', categoryPath: 'Privat/belege' }],
    confirmed: true,
    approveNewCategories: ['Privat'],
    confirmMove: false,
  } as never);
  expect(res.success).toBe(1);
  return res.items[0]!.targetPath!;
}

const documentTitles = (app: TestApp) =>
  app.services.documents
    .list({ limit: 50 })
    .map((d) => d.title)
    .toSorted();

describe('Restoring a backup', () => {
  it('replaces the database on the next start and keeps the replaced one', async () => {
    let app = await startApp();
    await archived(app, 'alt.txt', 'Dokument vom Backup');
    const backup = await app.ok('backup:create', { includeArchive: false });
    await archived(app, 'neu.txt', 'Dokument nach dem Backup');
    expect(documentTitles(app)).toEqual(['alt.txt', 'neu.txt']);

    const answer = await app.ok('backup:restore', { name: backup.name, confirmed: true });
    expect(answer).toEqual({ restartRequired: true });
    expect(documentTitles(app)).toEqual(['alt.txt', 'neu.txt']); // nothing changes while the application runs

    app = await restart(app);

    expect(documentTitles(app)).toEqual(['alt.txt']);
    expect(app.services.audit.list({ limit: 5 }).find((e) => e.action === 'backup.restore')?.after).toMatchObject({ restoredFrom: backup.name });
    const asides = fs.readdirSync(path.join(root, 'Archivist', 'database')).filter((f) => f.startsWith('vor-wiederherstellung-'));
    expect(asides).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'Archivist', 'database', asides[0]!, 'archivist.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Archivist', 'restore-pending.json'))).toBe(false);
    await restart(app); // the next start does not restore again
    expect(fs.readdirSync(path.join(root, 'Archivist', 'database')).filter((f) => f.startsWith('vor-wiederherstellung-'))).toHaveLength(1);
  });

  it('a full backup brings back archive files that are missing and never overwrites existing ones', async () => {
    let app = await startApp();
    const lost = await archived(app, 'verloren.txt', 'Verlorene Datei');
    const edited = await archived(app, 'bearbeitet.txt', 'Ursprünglicher Inhalt');
    const backup = await app.ok('backup:create', { includeArchive: true });
    fs.rmSync(lost);
    fs.writeFileSync(edited, 'Nachträglich geändert');

    await app.ok('backup:restore', { name: backup.name, confirmed: true });
    app = await restart(app);

    expect(fs.readFileSync(lost, 'utf8')).toBe('Verlorene Datei');
    expect(fs.readFileSync(edited, 'utf8')).toBe('Nachträglich geändert');
    expect(app.services.settings.get().archiveRoot).toBeTruthy();
  });

  it('a database file that cannot be set aside stays in place with all its parts, and the next start works', async () => {
    let app = await startApp();
    await archived(app, 'bleibt.txt', 'Dokument bleibt');
    const backup = await app.ok('backup:create', { includeArchive: false });
    await app.ok('backup:restore', { name: backup.name, confirmed: true });
    await app.services.shutdown();
    apps.splice(apps.indexOf(app), 1);
    const databaseDir = path.join(root, 'Archivist', 'database');
    fs.writeFileSync(path.join(databaseDir, 'archivist.db-wal'), '');
    const realRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('archivist.db-wal') && String(to).includes('vor-wiederherstellung-'))
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      realRename(from, to);
    });

    await expect(startApp()).rejects.toMatchObject({ category: 'filesystem_error', message: expect.stringContaining('nicht beiseitelegen') });
    rename.mockRestore();

    expect(fs.readdirSync(databaseDir).filter((f) => f.startsWith('vor-wiederherstellung-'))).toEqual([]);
    expect(fs.existsSync(path.join(databaseDir, 'archivist.db'))).toBe(true);
    app = await startApp();
    expect(documentTitles(app)).toEqual(['bleibt.txt']);
  });

  it('an unknown backup is refused and nothing is scheduled', async () => {
    const app = await startApp();

    const result = await app.call('backup:restore', { name: 'gibt-es-nicht', confirmed: true });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'Archivist', 'restore-pending.json'))).toBe(false);
  });

  it('a damaged backup is refused and nothing is scheduled', async () => {
    const app = await startApp();
    const backup = await app.ok('backup:create', { includeArchive: false });
    fs.writeFileSync(path.join(backup.path, 'archivist.db'), 'beschädigt '.repeat(500));

    const result = await app.call('backup:restore', { name: backup.name, confirmed: true });

    expect(result).toMatchObject({ ok: false, error: { category: 'database_corrupt' } });
    expect(fs.existsSync(path.join(root, 'Archivist', 'restore-pending.json'))).toBe(false);
  });

  it('needs the explicit confirmation', async () => {
    const app = await startApp();
    const backup = await app.ok('backup:create', { includeArchive: false });

    const result = await app.call('backup:restore', { name: backup.name } as never);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'Archivist', 'restore-pending.json'))).toBe(false);
  });

  it('after a damaged database the newest intact source is chosen', async () => {
    const app = await startApp();
    const older = await app.ok('backup:create', { includeArchive: false });
    const newer = await app.ok('backup:create', { includeArchive: false });
    fs.writeFileSync(path.join(newer.path, 'archivist.db'), 'beschädigt '.repeat(500));
    const paths = app.services.paths;

    const source = newestIntactSource(paths);

    expect(source?.name).toBe(older.name);
    expect(fs.existsSync(path.join(paths.root, 'restore-pending.json')), 'choosing schedules nothing').toBe(false);
  });

  it('recovers from a damaged database: start refused, restore scheduled, next start works', async () => {
    const first = await startApp();
    await archived(first, 'gerettet.txt', 'Dokument im Backup');
    await first.ok('backup:create', { includeArchive: false });
    await first.services.shutdown();
    apps.splice(apps.indexOf(first), 1);
    const dataRoot = path.join(root, 'Archivist');
    const databaseFile = path.join(dataRoot, 'database', 'archivist.db');
    fs.writeFileSync(databaseFile, 'beschädigt '.repeat(500));
    fs.rmSync(`${databaseFile}-wal`, { force: true });
    fs.rmSync(`${databaseFile}-shm`, { force: true });

    await expect(startApp()).rejects.toMatchObject({ category: 'database_corrupt' });
    const paths = resolveDataPaths(dataRoot);
    scheduleRestore(paths, newestIntactSource(paths)!.name);
    const recovered = await startApp();

    expect(documentTitles(recovered)).toEqual(['gerettet.txt']);
  });

  it('offers the database a restore replaced as a source and brings it back, again keeping the one it replaces', async () => {
    let app = await startApp();
    await archived(app, 'alt.txt', 'Dokument vom Backup');
    const backup = await app.ok('backup:create', { includeArchive: false });
    await archived(app, 'neu.txt', 'Dokument nach dem Backup');
    await app.ok('backup:restore', { name: backup.name, confirmed: true });
    app = await restart(app);
    expect(documentTitles(app)).toEqual(['alt.txt']);

    const aside = (await app.ok('backup:list', {})).find((b) => b.kind === 'before_restore');
    expect(aside?.name).toMatch(/^vor-wiederherstellung-/);
    expect(aside?.path).toBe(path.join(root, 'Archivist', 'database', aside!.name));
    expect(aside?.sizeBytes).toBeGreaterThan(0);
    const restoreEntry = app.services.audit.list({ limit: 5 }).find((e) => e.action === 'backup.restore');
    expect(restoreEntry?.after).toMatchObject({ restoredFrom: backup.name });

    await app.ok('backup:restore', { name: aside!.name, confirmed: true });
    app = await restart(app);

    expect(documentTitles(app)).toEqual(['alt.txt', 'neu.txt']);
    const asides = (await app.ok('backup:list', {})).filter((b) => b.kind === 'before_restore');
    expect(
      asides.map((b) => b.name),
      'the chain is kept: the first aside stays, the replaced state is aside again',
    ).toContain(aside!.name);
    expect(asides).toHaveLength(2);
  });

  it('brings the write-ahead log of a set-aside database along', async () => {
    const paths = resolveDataPaths(path.join(root, 'Archivist'));
    fs.mkdirSync(paths.backups, { recursive: true });
    const aside = path.join(paths.database, 'vor-wiederherstellung-2026-10-01T10-00-00-000');
    fs.mkdirSync(aside, { recursive: true });
    const source = new Database(path.join(root, 'quelle.db'));
    source.pragma('journal_mode = WAL');
    source.pragma('wal_autocheckpoint = 0');
    source.exec("CREATE TABLE notizen (text TEXT); INSERT INTO notizen VALUES ('nur im Log')");
    fs.copyFileSync(path.join(root, 'quelle.db'), path.join(aside, 'archivist.db'));
    fs.copyFileSync(path.join(root, 'quelle.db-wal'), path.join(aside, 'archivist.db-wal'));
    source.close();

    scheduleRestore(paths, path.basename(aside));
    applyPendingRestore(paths, path.join(root, 'archiv'));

    const restored = new Database(path.join(paths.database, 'archivist.db'), { readonly: true });
    expect(restored.prepare('SELECT text FROM notizen').all()).toEqual([{ text: 'nur im Log' }]);
    restored.close();
  });

  it('checking a backup never changes it: no files appear in the backup or aside folders', async () => {
    const app = await startApp();
    await archived(app, 'alt.txt', 'Dokument');
    const backup = await app.ok('backup:create', { includeArchive: false });
    const paths = app.services.paths;
    const listing = (dir: string) =>
      fs
        .readdirSync(dir, { recursive: true })
        .map((entry) => String(entry))
        .toSorted()
        .map((entry) => `${entry}:${fs.statSync(path.join(dir, entry)).size}`);
    const before = listing(paths.backups);

    await app.ok('backup:restore', { name: backup.name, confirmed: true });
    expect(newestIntactSource(paths)?.name).toBe(backup.name);

    expect(listing(paths.backups)).toEqual(before);
    expect(fs.readdirSync(paths.database).filter((f) => f.includes('.restoring'))).toEqual([]);
  });
});
