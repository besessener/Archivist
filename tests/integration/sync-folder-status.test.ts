import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

const outsideSync = () => fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-plain-'));

describe('Sync-folder warning covers the data folder too (#207)', () => {
  it('reports the sync service of the data folder, where inbox, quarantine and trash live', async () => {
    const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-sync-')), 'OneDrive - Firma');
    app = await createTestApp({ dataRoot });
    app.services.settings.update({ archiveRoot: outsideSync() });

    expect(await app.ok('app:getStatus', {})).toMatchObject({ archiveSyncProvider: null, dataSyncProvider: 'OneDrive' });
  });

  it('says nothing for ordinary folders and still reports the archive on its own', async () => {
    app = await createTestApp();
    app.services.settings.update({ archiveRoot: outsideSync() });
    expect(await app.ok('app:getStatus', {})).toMatchObject({ archiveSyncProvider: null, dataSyncProvider: null });

    app.services.settings.update({ archiveRoot: path.join(outsideSync(), 'Dropbox', 'Archiv') });
    expect(await app.ok('app:getStatus', {})).toMatchObject({ archiveSyncProvider: 'Dropbox', dataSyncProvider: null });
  });

  it('tells whether database, settings and backups lie in the data folder too', async () => {
    app = await createTestApp();
    expect((await app.ok('app:getStatus', {})).appStateInDataRoot).toBe(true);
    await app.cleanup();

    app = await createTestApp({ separateAppData: true });
    expect((await app.ok('app:getStatus', {})).appStateInDataRoot).toBe(false);
  });
});
