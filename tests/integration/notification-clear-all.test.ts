import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

describe('Clearing all notifications', () => {
  it('resolves every open notification, resets the unread count and keeps them in the history', async () => {
    for (const title of ['Erste', 'Zweite', 'Dritte']) app.services.notifications.create({ title, description: 'Test', type: 'system' });
    expect(await app.ok('notifications:list', {})).toHaveLength(3);
    expect(app.services.notifications.unreadCount()).toBe(3);

    expect(await app.ok('notifications:resolveAll', {})).toEqual({ resolved: 3 });

    expect(await app.ok('notifications:list', {})).toHaveLength(0);
    expect(app.services.notifications.unreadCount()).toBe(0);
    const history = await app.ok('notifications:list', { includeResolved: true });
    expect(history).toHaveLength(3);
    expect(history.every((n) => n.resolvedAt && n.readAt)).toBe(true);
  });

  it('is a no-op when nothing is open', async () => {
    expect(await app.ok('notifications:resolveAll', {})).toEqual({ resolved: 0 });
  });
});
