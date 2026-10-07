import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@archivist/shared';
import { UpdateController, unsupportedUpdateReason, type UpdaterLike } from '../../apps/desktop/src/updater';

function setup(options: { reason?: string | null; latest?: string | null; failCheck?: boolean; failDownload?: boolean } = {}) {
  const changes: UpdateStatus[] = [];
  const calls: string[] = [];
  let progress: (p: { percent: number }) => void = () => undefined;
  const updater: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: async () => {
      calls.push('check');
      if (options.failCheck) throw new Error('offline');
      return options.latest === null ? null : { updateInfo: { version: options.latest ?? '2.0.0' } };
    },
    downloadUpdate: async () => {
      calls.push('download');
      progress({ percent: 41.6 });
      if (options.failDownload) throw new Error('disk full');
    },
    quitAndInstall: (silent, run) => calls.push(`install:${silent}:${run}`),
    on: (_event, listener) => {
      progress = listener;
    },
  };
  const controller = new UpdateController({
    updater,
    currentVersion: '1.0.0',
    unsupportedReason: options.reason ?? null,
    onChange: (status) => changes.push(status),
    prepareInstall: async () => {
      calls.push('shutdown');
    },
  });
  return { controller, updater, changes, calls };
}

describe('UpdateController', () => {
  it('never downloads or installs on its own', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('reports a newer release as available and the same version as up to date', async () => {
    const newer = setup({ latest: '2.0.0' });
    expect(await newer.controller.check()).toEqual({ state: 'available', version: '2.0.0' });
    expect(newer.changes.map((s) => s.state)).toEqual(['checking', 'available']);

    expect(await setup({ latest: '1.0.0' }).controller.check()).toEqual({ state: 'upToDate' });
    expect(await setup({ latest: null }).controller.check()).toEqual({ state: 'upToDate' });
  });

  it('turns a failed check into a German error and allows a retry', async () => {
    const { controller } = setup({ failCheck: true });
    const status = await controller.check();
    expect(status.state).toBe('error');
    expect(status).toMatchObject({ message: expect.stringContaining('Updates') });
    expect((await controller.check()).state).toBe('error');
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

  it('turns a failed download into a German error', async () => {
    const { controller } = setup({ failDownload: true });
    await controller.check();
    expect((await controller.download()).state).toBe('error');
  });

  it('installs only a downloaded update and shuts down first', async () => {
    const { controller, calls } = setup();
    await controller.install();
    await controller.check();
    await controller.install();
    expect(calls).toEqual(['check']);

    await controller.download();
    await controller.install();
    expect(calls.slice(-2)).toEqual(['shutdown', 'install:true:true']);
  });

  it('does nothing in builds that cannot update', async () => {
    const { controller, calls } = setup({ reason: 'nein' });
    expect(controller.status()).toEqual({ state: 'unsupported', reason: 'nein' });
    expect(await controller.check()).toEqual({ state: 'unsupported', reason: 'nein' });
    expect(await controller.download()).toEqual({ state: 'unsupported', reason: 'nein' });
    expect(calls).toEqual([]);
  });
});

describe('unsupportedUpdateReason', () => {
  const installed = { packaged: true, platform: 'win32', portable: false };

  it('allows the installed Windows version only', () => {
    expect(unsupportedUpdateReason(installed)).toBeNull();
    expect(unsupportedUpdateReason({ ...installed, packaged: false })).toContain('Entwicklungsversion');
    expect(unsupportedUpdateReason({ ...installed, platform: 'linux' })).toContain('Windows');
    expect(unsupportedUpdateReason({ ...installed, portable: true })).toContain('portablen');
  });
});
