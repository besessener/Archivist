import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@archivist/shared';
import { UpdateController, createUpdateHost, fakeUpdater, initialUpdateStatus, type UpdaterLike } from '../../apps/desktop/src/updater';
import { updateFailureMessage } from '../../apps/desktop/src/update-messages';

interface SetupOptions {
  initialStatus?: UpdateStatus;
  latest?: { version: string; isUpdateAvailable: boolean } | null;
  checkError?: Error;
  downloadError?: Error;
  quitError?: Error;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function setup(options: SetupOptions = {}) {
  const changes: UpdateStatus[] = [];
  const calls: string[] = [];
  const logged: { message: string; error: unknown }[] = [];
  let progress: (p: { percent: number }) => void = () => undefined;
  const latest = options.latest === undefined ? { version: '2.0.0', isUpdateAvailable: true } : options.latest;
  const updater: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: async () => {
      calls.push('check');
      if (options.checkError) throw options.checkError;
      return latest === null ? null : { isUpdateAvailable: latest.isUpdateAvailable, updateInfo: { version: latest.version } };
    },
    downloadUpdate: async () => {
      calls.push('download');
      progress({ percent: 41.6 });
      if (options.downloadError) throw options.downloadError;
    },
    quitAndInstall: (silent, run) => calls.push(`installer:${silent}:${run}`),
    on: (_event, listener) => {
      progress = listener;
    },
  };
  const controller = new UpdateController({
    updater,
    initialStatus: options.initialStatus ?? { state: 'idle' },
    onChange: (status) => changes.push(status),
    quit: async (startInstaller) => {
      calls.push('quit');
      if (options.quitError) throw options.quitError;
      startInstaller();
    },
    log: (message, error) => logged.push({ message, error }),
  });
  return { controller, updater, changes, calls, logged };
}

async function downloaded(options: SetupOptions = {}) {
  const context = setup(options);
  await context.controller.check();
  await context.controller.download();
  return context;
}

describe('UpdateController', () => {
  it('never downloads or installs on its own', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('reports a release as available only when electron-updater considers it an update', async () => {
    const newer = setup();
    expect(await newer.controller.check()).toEqual({ state: 'available', version: '2.0.0' });
    expect(newer.changes.map((s) => s.state)).toEqual(['checking', 'available']);

    expect(await setup({ latest: { version: '1.0.0', isUpdateAvailable: false } }).controller.check()).toEqual({ state: 'upToDate' });
    expect(await setup({ latest: null }).controller.check()).toEqual({ state: 'upToDate' });
  });

  it('does not offer an older release (e.g. after the newest one was withdrawn) as an update', async () => {
    const { controller } = setup({ latest: { version: '0.9.0', isUpdateAvailable: false } });
    expect(await controller.check()).toEqual({ state: 'upToDate' });
  });

  it('turns a failed check into a German error, logs the cause and allows a retry', async () => {
    const cause = new Error('net::ERR_INTERNET_DISCONNECTED');
    const { controller, logged } = setup({ checkError: cause });
    const status = await controller.check();
    expect(status).toEqual({ state: 'error', message: expect.stringContaining('Internetverbindung') });
    expect(logged).toEqual([{ message: 'Update check failed', error: cause }]);
    expect((await controller.check()).state).toBe('error');
  });

  it('explains a release that is not fully published yet instead of blaming the internet connection', async () => {
    const { controller } = setup({ checkError: codedError('Cannot find latest.yml', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') });
    const status = await controller.check();
    expect(status).toEqual({ state: 'error', message: expect.stringContaining('noch nicht vollständig veröffentlicht') });
    expect(status).not.toMatchObject({ message: expect.stringContaining('Internetverbindung') });
  });

  it('downloads only after a check found a release, reporting progress', async () => {
    const { controller, calls, changes } = setup();
    expect((await controller.download()).state).toBe('idle');
    expect(calls).toEqual([]);

    await controller.check();
    expect(await controller.download()).toEqual({ state: 'downloaded', version: '2.0.0' });
    expect(changes).toContainEqual({ state: 'downloading', version: '2.0.0', percent: 0 });
    expect(changes.some((s) => s.state === 'downloading' && s.percent === 42)).toBe(true);
  });

  it('turns a failed download into a German error and logs the cause', async () => {
    const cause = codedError('sha512 checksum mismatch', 'ERR_CHECKSUM_MISMATCH');
    const { controller, logged } = await downloaded({ downloadError: cause });
    expect(controller.status()).toEqual({ state: 'error', message: expect.stringContaining('beschädigt') });
    expect(logged).toEqual([{ message: 'Update download failed', error: cause }]);
  });

  it('keeps a downloaded update: a new check neither runs nor discards it', async () => {
    const { controller, calls } = await downloaded();
    expect(await controller.check()).toEqual({ state: 'downloaded', version: '2.0.0' });
    expect(calls.filter((call) => call === 'check')).toHaveLength(1);
  });

  it('installs only a downloaded update, through the bounded quit path', async () => {
    const { controller, calls } = setup();
    await controller.install();
    await controller.check();
    await controller.install();
    expect(calls).toEqual(['check']);

    await controller.download();
    await controller.install();
    expect(calls.slice(-2)).toEqual(['quit', 'installer:true:true']);
  });

  it('shows the installation at once and starts it only once, even when asked twice', async () => {
    const { controller, calls, changes } = await downloaded();
    await Promise.all([controller.install(), controller.install()]);
    expect(changes.at(-1)).toEqual({ state: 'installing', version: '2.0.0' });
    expect(calls.filter((call) => call === 'quit')).toHaveLength(1);
    expect(await controller.check()).toEqual({ state: 'installing', version: '2.0.0' });
  });

  it('reports an error instead of staying silent when quitting for the installation fails', async () => {
    const cause = new Error('quit failed');
    const { controller, logged } = await downloaded({ quitError: cause });
    await controller.install();
    expect(controller.status()).toEqual({ state: 'error', message: expect.stringContaining('installiert') });
    expect(logged).toEqual([{ message: 'Update installation failed', error: cause }]);
  });

  it('does nothing in builds that cannot update', async () => {
    const unsupported: UpdateStatus = { state: 'unsupported', reason: 'nein' };
    const { controller, calls } = setup({ initialStatus: unsupported });
    expect(controller.status()).toEqual(unsupported);
    expect(await controller.check()).toEqual(unsupported);
    expect(await controller.download()).toEqual(unsupported);
    expect(calls).toEqual([]);
  });
});

describe('initialUpdateStatus', () => {
  const installed = { packaged: true, platform: 'win32', portable: false };

  it('allows the installed Windows version only', () => {
    expect(initialUpdateStatus(installed)).toEqual({ state: 'idle' });
    expect(initialUpdateStatus({ ...installed, packaged: false })).toMatchObject({
      state: 'unsupported',
      reason: expect.stringContaining('Entwicklungsversion'),
    });
    expect(initialUpdateStatus({ ...installed, platform: 'linux' })).toMatchObject({ state: 'unsupported', reason: expect.stringContaining('Windows') });
    expect(initialUpdateStatus({ ...installed, portable: true })).toMatchObject({ state: 'unsupported', reason: expect.stringContaining('portablen') });
  });
});

describe('updateFailureMessage', () => {
  it('names known causes and falls back to a message per step', () => {
    expect(updateFailureMessage('download', codedError('no space', 'ENOSPC'))).toContain('nicht genug Platz');
    expect(updateFailureMessage('download', codedError('bad', 'ERR_UPDATER_INVALID_SIGNATURE'))).toContain('Signatur');
    expect(updateFailureMessage('download', codedError('missing', 'ERR_UPDATER_ASSET_NOT_FOUND'))).toContain('noch nicht vollständig veröffentlicht');
    expect(updateFailureMessage('check', codedError('odd', 'ERR_SOMETHING_ELSE'))).toContain('Internetverbindung');
    expect(updateFailureMessage('download', 'kein Error-Objekt')).toContain('nicht heruntergeladen');
    expect(updateFailureMessage('install', new Error('x'))).toContain('nicht installiert');
  });
});

describe('the E2E stand-in for electron-updater', () => {
  it('offers the given version, downloads with progress and leaves installing to the test', async () => {
    const percents: number[] = [];
    const updater = fakeUpdater('9.9.9');
    updater.on('download-progress', ({ percent }) => percents.push(percent));
    expect(await updater.checkForUpdates()).toEqual({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } });
    await updater.downloadUpdate();
    expect(percents).toEqual([50]);
    expect(() => updater.quitAndInstall(true, true)).not.toThrow();
  });
});

describe('createUpdateHost', () => {
  const host = (testVersion?: string) => {
    const quits: string[] = [];
    const updates = createUpdateHost({
      updater: fakeUpdater('1.0.0'),
      build: { packaged: false, platform: 'linux', portable: false },
      testVersion,
      onChange: () => undefined,
      quit: async () => void quits.push('quit'),
      log: () => undefined,
    });
    return { updates, quits };
  };

  it('uses the real updater and the build’s own status without a test version', () => {
    expect(host().updates.status()).toMatchObject({ state: 'unsupported' });
  });

  it('lets an E2E test go through the whole journey without quitting the application', async () => {
    const { updates, quits } = host('9.9.9');
    expect(await updates.check()).toEqual({ state: 'available', version: '9.9.9' });
    await updates.download();
    await updates.install();
    expect(updates.status()).toEqual({ state: 'installing', version: '9.9.9' });
    expect(quits).toEqual([]);
  });
});
