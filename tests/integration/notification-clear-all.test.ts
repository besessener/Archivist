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

describe('Marking all notifications as read', () => {
  it('marks every open unread notification, also beyond the ones the bell shows, and keeps them open', async () => {
    for (let n = 0; n < 60; n += 1) app.services.notifications.create({ title: `Nr. ${n}`, description: 'Test', type: 'system' });
    const first = app.services.notifications.list({ limit: 1 })[0]!;
    app.services.notifications.resolve(first.id);
    expect(app.services.notifications.unreadCount()).toBe(59);

    expect(await app.ok('notifications:markAllRead', {})).toEqual({ marked: 59 });

    expect(app.services.notifications.unreadCount()).toBe(0);
    const open = await app.ok('notifications:list', { limit: 500 });
    expect(open).toHaveLength(59);
    expect(open.every((n) => n.readAt && !n.resolvedAt)).toBe(true);
    expect(await app.ok('notifications:markAllRead', {})).toEqual({ marked: 0 });
  });
});
