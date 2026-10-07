import { afterEach, describe, expect, it } from 'vitest';
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

  it('store the startup check choice', async () => {
    app = await createTestApp();
    await app.ok('settings:update', { updates: { checkOnStartup: false } });
    expect(app.services.settings.get().updates.checkOnStartup).toBe(false);
  });
});
