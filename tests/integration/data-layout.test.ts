import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyLayout } from '../../packages/core/src/services/data-layout-migration';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

// Database, config, logs and backups live in the per-user data folder; older installs are moved there at start (#207).

let root: string;
const apps: TestApp[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-layout-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.services.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

const legacy = () => path.join(root, 'Archivist');
const appData = () => path.join(root, 'AppData');
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file: string) => fs.readFileSync(file, 'utf8');

async function startApp(options: { separateAppData: boolean }): Promise<TestApp> {
  const app = await createTestApp({ dataRoot: root, privacy: 'auto', ...options });
  apps.push(app);
  return app;
}

async function stop(app: TestApp): Promise<void> {
  await app.services.shutdown();
  apps.splice(apps.indexOf(app), 1);
}

async function archiveDocument(app: TestApp): Promise<void> {
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Mietvertrag', summary: 'Zusammenfassung', categoryPath: 'private/belege', mainTopic: null }),
  );
  const imported = await app.ok('documents:import', { paths: [app.file('in/mietvertrag.txt', 'Mietvertrag mit Kaution')] });
  await app.services.jobs.whenIdle();
  const archived = await app.ok('documents:archive', {
    items: [{ documentId: imported.imported[0]!.id, mode: 'copy', categoryPath: 'private/belege' }],
    confirmed: true,
    approveNewCategories: ['private'],
    confirmMove: false,
  } as never);
  expect(archived.success).toBe(1);
}

describe('Application data in the per-user data folder', () => {
  it('keeps documents in the document store and state in the data folder', async () => {
    const app = await startApp({ separateAppData: true });
    await archiveDocument(app);

    for (const dir of ['database', 'index', 'config', 'logs', 'backups']) {
      expect(fs.existsSync(path.join(appData(), dir)), `${dir} in the data folder`).toBe(true);
      expect(fs.existsSync(path.join(legacy(), dir)), `${dir} not next to the documents`).toBe(false);
    }
    for (const dir of ['archive', 'inbox', 'quarantine', 'trash']) expect(fs.existsSync(path.join(legacy(), dir)), dir).toBe(true);
    expect(app.services.paths.appData).toBe(appData());
  });

  it('does not let the scanner walk into the data folder', async () => {
    const app = await startApp({ separateAppData: true });

    expect((await app.call('scanner:addDirectory', { path: appData(), recursive: true })).ok).toBe(false);
  });

  it('moves an install from the old layout at start without losing documents, backups or settings', async () => {
    const old = await startApp({ separateAppData: false });
    await archiveDocument(old);
    await old.ok('backup:create', { includeArchive: false });
    await old.ok('settings:update', { backups: { keep: 7 } });
    write(path.join(legacy(), 'restore-pending.json'), JSON.stringify({ name: 'metadaten-x', requestedAt: 'now' }));
    await stop(old);
    fs.rmSync(path.join(legacy(), 'restore-pending.json'));

    const moved = await startApp({ separateAppData: true });

    expect(moved.services.documents.list({ limit: 10 }).map((d) => d.title)).toEqual(['Mietvertrag']);
    expect(await moved.ok('backup:list', {})).toHaveLength(1);
    expect(moved.services.settings.get().backups.keep).toBe(7);
    expect(fs.existsSync(path.join(legacy(), 'database'))).toBe(false);
    expect(fs.existsSync(path.join(legacy(), 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(legacy(), 'archive', 'private', 'belege', 'mietvertrag.txt'))).toBe(true);
    expect(JSON.parse(read(path.join(appData(), 'layout-migration.json')))).toMatchObject({ status: 'complete', from: legacy() });
  });
});

describe('Moving the old layout', () => {
  const places = () => ({ legacyRoot: legacy(), appDataRoot: appData() });
  const seed = () => {
    write(path.join(legacy(), 'database', 'archivist.db'), 'datenbank');
    write(path.join(legacy(), 'config', 'settings.json'), '{"a":1}');
    write(path.join(legacy(), 'backups', 'metadaten-1', 'manifest.json'), '{}');
    write(path.join(legacy(), 'restore-pending.json'), '{"name":"x"}');
    write(path.join(legacy(), 'archive', 'doc.txt'), 'Originalkopie');
  };

  it('copies, verifies, switches and leaves the documents alone', () => {
    seed();

    const result = migrateLegacyLayout(places());

    expect(result).toMatchObject({ migrated: true, entries: ['database', 'config', 'backups', 'restore-pending.json'] });
    expect(read(path.join(appData(), 'database', 'archivist.db'))).toBe('datenbank');
    expect(read(path.join(appData(), 'backups', 'metadaten-1', 'manifest.json'))).toBe('{}');
    expect(read(path.join(appData(), 'restore-pending.json'))).toBe('{"name":"x"}');
    expect(fs.existsSync(path.join(legacy(), 'database'))).toBe(false);
    expect(fs.existsSync(path.join(legacy(), 'restore-pending.json'))).toBe(false);
    expect(read(path.join(legacy(), 'archive', 'doc.txt'))).toBe('Originalkopie');
    expect(fs.existsSync(path.join(appData(), '.layout-migration'))).toBe(false);
  });

  it('runs only once: later starts leave everything as it is', () => {
    seed();
    migrateLegacyLayout(places());
    write(path.join(legacy(), 'database', 'archivist.db'), 'neuere Datei eines alten Programms');

    expect(migrateLegacyLayout(places())).toEqual({ migrated: false });
    expect(read(path.join(legacy(), 'database', 'archivist.db'))).toBe('neuere Datei eines alten Programms');
    expect(read(path.join(appData(), 'database', 'archivist.db'))).toBe('datenbank');
  });

  it('marks a fresh install as done, so a folder appearing later is not touched', () => {
    expect(migrateLegacyLayout(places())).toEqual({ migrated: false });
    write(path.join(legacy(), 'database', 'archivist.db'), 'fremd');

    expect(migrateLegacyLayout(places())).toEqual({ migrated: false });
    expect(read(path.join(legacy(), 'database', 'archivist.db'))).toBe('fremd');
  });

  it('refuses to overwrite data in the target and changes nothing', () => {
    seed();
    write(path.join(appData(), 'database', 'archivist.db'), 'andere Datenbank');

    expect(() => migrateLegacyLayout(places())).toThrow(
      expect.objectContaining({ category: 'filesystem_error', message: expect.stringContaining('dort liegt aber schon etwas') }),
    );
    expect(read(path.join(appData(), 'database', 'archivist.db'))).toBe('andere Datenbank');
    expect(read(path.join(legacy(), 'database', 'archivist.db'))).toBe('datenbank');
    expect(fs.existsSync(path.join(legacy(), 'config'))).toBe(true);
  });

  it('keeps the old data when a copy does not verify', () => {
    seed();
    const copy = fs.cpSync;
    vi.spyOn(fs, 'cpSync').mockImplementation((from, to, options) => {
      copy(from, to, options);
      if (path.basename(String(from)) === 'config') fs.writeFileSync(path.join(String(to), 'settings.json'), '{"a":2}');
    });

    expect(() => migrateLegacyLayout(places())).toThrow(
      expect.objectContaining({ message: expect.stringContaining('Deine bisherigen Daten sind unverändert') }),
    );
    expect(read(path.join(legacy(), 'config', 'settings.json'))).toBe('{"a":1}');
    expect(read(path.join(legacy(), 'database', 'archivist.db'))).toBe('datenbank');
    expect(fs.existsSync(path.join(appData(), '.layout-migration'))).toBe(false);
    expect(fs.existsSync(path.join(appData(), 'database'))).toBe(false);
  });

  it('starts over after a copy that was interrupted before the switch', () => {
    seed();
    write(path.join(appData(), '.layout-migration', 'database', 'archivist.db'), 'halb');

    migrateLegacyLayout(places());

    expect(read(path.join(appData(), 'database', 'archivist.db'))).toBe('datenbank');
  });

  it('resumes a switch that was interrupted halfway', () => {
    seed();
    const stage = path.join(appData(), '.layout-migration');
    fs.cpSync(path.join(legacy(), 'config'), path.join(stage, 'config'), { recursive: true });
    fs.cpSync(path.join(legacy(), 'database'), path.join(appData(), 'database'), { recursive: true }); // already switched
    write(path.join(appData(), 'layout-migration.json'), JSON.stringify({ status: 'switching', entries: ['database', 'config'], from: legacy(), at: 'now' }));

    expect(migrateLegacyLayout(places())).toMatchObject({ migrated: true });

    expect(read(path.join(appData(), 'config', 'settings.json'))).toBe('{"a":1}');
    expect(read(path.join(appData(), 'database', 'archivist.db'))).toBe('datenbank');
    expect(fs.existsSync(path.join(legacy(), 'config'))).toBe(false);
    expect(fs.existsSync(path.join(legacy(), 'database'))).toBe(false);
    expect(JSON.parse(read(path.join(appData(), 'layout-migration.json')))).toMatchObject({ status: 'complete' });
  });
});
