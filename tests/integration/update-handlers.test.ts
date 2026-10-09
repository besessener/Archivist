import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@archivist/shared';
import { updateHandlers } from '../../packages/core/src/handlers/update';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

describe('app update channels', () => {
  it('report "unsupported" when the host cannot update and check for updates by default', async () => {
    app = await createTestApp();
    expect(app.services.settings.get().updates.checkOnStartup).toBe(true);
    expect(await app.ok('update:status', {})).toMatchObject({ state: 'unsupported' });
    expect(await app.ok('update:check', {})).toMatchObject({ state: 'unsupported' });
  });

  it('refuse download and install without explicit confirmation', async () => {
    app = await createTestApp();
    expect((await app.dispatch('update:download', {})).ok).toBe(false);
    expect((await app.dispatch('update:install', {})).ok).toBe(false);
    expect((await app.dispatch('update:download', { confirmed: true })).ok).toBe(true);
  });

  it('refuse to install when no update is downloaded instead of reporting success', async () => {
    app = await createTestApp();
    const result = await app.dispatch('update:install', { confirmed: true });
    expect(result).toMatchObject({ ok: false, error: { category: 'validation_error' } });
  });

  it('install only a downloaded update', async () => {
    app = await createTestApp();
    let status: UpdateStatus = { state: 'available', version: '2.0.0' };
    const installs: string[] = [];
    const updates = { status: () => status, check: async () => status, download: async () => status, install: () => void installs.push('install') };
    const handlers = updateHandlers({ ...app.host, updates });
    expect(() => handlers['update:install']({ confirmed: true })).toThrow(expect.objectContaining({ category: 'validation_error' }));
    expect(installs).toEqual([]);

    status = { state: 'downloaded', version: '2.0.0' };
    expect(handlers['update:install']({ confirmed: true })).toEqual({ ok: true });
    expect(installs).toEqual(['install']);
  });

  it('store the startup check choice', async () => {
    app = await createTestApp();
    await app.ok('settings:update', { updates: { checkOnStartup: false } });
    expect(app.services.settings.get().updates.checkOnStartup).toBe(false);
  });
});
