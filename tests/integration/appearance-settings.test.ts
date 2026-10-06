import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

describe('colour scheme setting', () => {
  it('follows the system by default, stores a choice and rejects unknown schemes', async () => {
    app = await createTestApp();
    expect(app.services.settings.get().appearance.theme).toBe('system');

    await app.ok('settings:update', { appearance: { theme: 'dark' } });
    expect(app.services.settings.get().appearance.theme).toBe('dark');
    expect((await app.ok('app:getStatus', {})).theme).toBe('dark');

    const rejected = await app.dispatch('settings:update', { appearance: { theme: 'pink' } });
    expect(rejected.ok).toBe(false);
    expect(app.services.settings.get().appearance.theme).toBe('dark');
  });
});
