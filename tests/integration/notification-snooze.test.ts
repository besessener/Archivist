import type { AppNotification } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

const open = () => app.ok('notifications:list', {});

describe('Snoozed notification keeps its actions (#79)', () => {
  it('reopens the original notification with unchanged title, actions and targets when the reminder is due', async () => {
    const original = app.services.notifications.create({
      title: 'Widerspruch prüfen',
      description: 'Zwei Entscheidungen widersprechen sich.',
      type: 'contradiction',
      priority: 'high',
      affectedEntityIds: ['dec-1', 'dec-2'],
      proposedActions: [
        { label: 'Neuere übernehmen', kind: 'confirm_action', target: 'contradiction:abc' },
        { label: 'Entscheidungen öffnen', kind: 'navigate', target: '/decisions/' },
      ],
      dedupeKey: 'contradiction:abc',
    });
    await app.ok('notifications:markRead', { ids: [original.id] });

    const reminder = await app.ok('notifications:snooze', { id: original.id, remindAt: '2020-01-01' });
    expect(reminder).toMatchObject({ targetType: 'notification', targetId: original.id });
    expect(await open()).toHaveLength(0);

    const announced: AppNotification[] = [];
    app.services.events.on('notification:new', (n: AppNotification) => announced.push(n));
    expect(app.services.reminders.checkDue()).toBe(1);

    const list = await open();
    expect(list).toHaveLength(1);
    const back = list[0]!;
    expect(back.id).toBe(original.id);
    expect(back.title).toBe('Widerspruch prüfen');
    expect(back.type).toBe('contradiction');
    expect(back.priority).toBe('high');
    expect(back.proposedActions).toEqual(original.proposedActions);
    expect(back.affectedEntityIds).toEqual(['dec-1', 'dec-2']);
    expect(back.readAt).toBeNull();
    expect(back.resolvedAt).toBeNull();
    expect(announced.map((n) => n.id)).toEqual([original.id]);
    expect((await app.ok('reminders:list', {}))[0]!.status).toBe('fired');

    expect(app.services.reminders.checkDue()).toBe(0);
    expect(await open()).toHaveLength(1);
  });

  it('a snoozed reminder notification comes back without a doubled prefix', async () => {
    const item = await app.ok('openItems:create', { title: 'PoC vorstellen', priority: 'normal', sourceIds: [], confidence: 0.9 });
    app.services.reminders.create({ targetType: 'open_item', targetId: item.id, title: 'PoC vorstellen', remindAt: '2020-01-01' });
    app.services.reminders.checkDue();
    const first = (await open())[0]!;
    expect(first.title).toBe('Erinnerung: PoC vorstellen');

    await app.ok('notifications:snooze', { id: first.id, remindAt: '2020-01-02' });
    app.services.reminders.checkDue();

    const list = await open();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(first.id);
    expect(list[0]!.title).toBe('Erinnerung: PoC vorstellen');
    expect(list[0]!.proposedActions).toEqual(first.proposedActions);
    expect(list[0]!.proposedActions.some((a) => a.kind === 'navigate' && a.target === '/open-items/')).toBe(true);
  });

  it('falls back to a generic reminder without a doubled prefix if the notification no longer exists', async () => {
    app.services.reminders.create({ targetType: 'notification', targetId: 'missing', title: 'Erinnerung: Angebot', remindAt: '2020-01-01' });
    app.services.reminders.checkDue();
    const list = await open();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('Erinnerung: Angebot');
  });
});
