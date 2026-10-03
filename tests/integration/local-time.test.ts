import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDefaultTimeZone } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

// #77: "today", "overdue", reminders and timeline days follow local time, not UTC.
let app: TestApp;

/** Not via process.env.TZ: in worker threads (Stryker/Vitest pool) it does not change the ICU default zone. */
function useZoneAndClock(timeZone: string, iso: string): void {
  setDefaultTimeZone(timeZone);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  vi.useRealTimers();
  setDefaultTimeZone(null);
  await app.cleanup();
});

const createItem = (title: string, dueAt: string) => app.ok('openItems:create', { title, dueAt, priority: 'normal', sourceIds: [], confidence: 0.9 });
/** Titles of the due/overdue notifications, sorted. */
const dueTitles = async () =>
  (await app.ok('notifications:list', {}))
    .map((n) => n.title)
    .filter((t) => /^(Heute fällig|Überfällig):/.test(t))
    .sort();

describe('Reminders fire at a fixed local time (#77)', () => {
  it('fires a date-only reminder at 08:00 Berlin time, not at midnight UTC', () => {
    app.services.reminders.create({ targetType: 'custom', targetId: null, title: 'Angebot nachfassen', remindAt: '2026-10-05' });
    // 00:00 UTC is 02:00 in Berlin – previously the reminder fired here
    expect(app.services.reminders.checkDue(new Date('2026-10-05T00:00:00Z'), 'Europe/Berlin')).toBe(0);
    expect(app.services.reminders.checkDue(new Date('2026-10-05T05:59:00Z'), 'Europe/Berlin')).toBe(0);
    expect(app.services.reminders.checkDue(new Date('2026-10-05T06:00:00Z'), 'Europe/Berlin')).toBe(1);
    expect(app.services.reminders.checkDue(new Date('2026-10-05T07:00:00Z'), 'Europe/Berlin')).toBe(0);
  });

  it('uses the configured reminder time and the local zone', async () => {
    await app.ok('settings:update', { notifications: { reminderTime: '07:30' } });
    app.services.reminders.create({ targetType: 'custom', targetId: null, title: 'Steuer', remindAt: '2026-10-05' });
    expect(app.services.reminders.checkDue(new Date('2026-10-05T11:29:00Z'), 'America/New_York')).toBe(0);
    expect(app.services.reminders.checkDue(new Date('2026-10-05T11:30:00Z'), 'America/New_York')).toBe(1);
  });

  it('rejects an invalid reminder time', async () => {
    const res = await app.call('settings:update', { notifications: { reminderTime: '25:00' } });
    expect(res.ok).toBe(false);
    expect(app.services.settings.get().notifications.reminderTime).toBe('08:00');
  });

  it('fires reminders with an explicit time at that moment and names the local day', async () => {
    app.services.reminders.create({ targetType: 'custom', targetId: null, title: 'Telefonat', remindAt: '2026-09-30T22:30:00Z' });
    app.services.reminders.create({ targetType: 'custom', targetId: null, title: 'Später', remindAt: '2026-10-01T14:00' });
    expect(app.services.reminders.checkDue(new Date('2026-09-30T22:29:00Z'), 'Europe/Berlin')).toBe(0);
    expect(app.services.reminders.checkDue(new Date('2026-09-30T22:30:00Z'), 'Europe/Berlin')).toBe(1);
    const [n] = await app.ok('notifications:list', {});
    expect(n!.title).toBe('Erinnerung: Telefonat');
    expect(n!.description).toBe('Geplant für 2026-10-01.');
    // a wall-clock time without a zone is local time (14:00 Berlin = 12:00 UTC)
    expect(app.services.reminders.checkDue(new Date('2026-10-01T11:59:00Z'), 'Europe/Berlin')).toBe(0);
    expect(app.services.reminders.checkDue(new Date('2026-10-01T12:00:00Z'), 'Europe/Berlin')).toBe(1);
  });

  it('wakes a snoozed insight together with its reminder at the local reminder time', async () => {
    useZoneAndClock('Europe/Berlin', '2026-10-01T10:00:00Z');
    const insight = app.services.insights.upsert({
      kind: 'open_item',
      title: 'Lange unverändert: Angebot',
      explanation: 'Seit 40 Tagen unverändert.',
      confidence: 0.7,
      affected: [],
      sourceIds: [],
      dedupeKey: 'local-time:insight',
    });
    await app.ok('insights:respond', { response: 'remind_later', id: insight.id, remindAt: '2026-10-05' });

    vi.setSystemTime(new Date('2026-10-05T05:00:00Z')); // 07:00 Berlin
    expect(app.services.insights.list().find((i) => i.id === insight.id)!.status).toBe('snoozed');
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z')); // 08:00 Berlin
    expect(app.services.insights.list().find((i) => i.id === insight.id)!.status).toBe('open');
  });
});

describe('Overdue and due today follow the local day (#77)', () => {
  it('at 00:30 Berlin time an item due yesterday is overdue, not due today', async () => {
    const yesterday = await createItem('Bericht abgeben', '2026-09-30');
    const today = await createItem('Rechnung prüfen', '2026-10-01');
    await createItem('Termin vorbereiten', '2026-10-02');

    useZoneAndClock('Europe/Berlin', '2026-09-30T22:30:00Z'); // 2026-10-01 00:30 local
    expect(app.services.openItems.overdue().map((i) => i.id)).toEqual([yesterday.id]);
    await app.services.consistency.run({ trigger: 'test' });
    expect(await dueTitles()).toEqual(['Heute fällig: Rechnung prüfen', 'Überfällig: Bericht abgeben']);
    expect((await app.ok('notifications:list', {})).find((n) => n.title.startsWith('Heute fällig'))!.affectedEntityIds).toEqual([today.id]);
  });

  it('at 23:30 New York time the UTC date is already tomorrow, but nothing is overdue yet', async () => {
    await createItem('Rechnung prüfen', '2026-10-01');
    useZoneAndClock('America/New_York', '2026-10-02T03:30:00Z'); // 2026-10-01 23:30 local
    expect(app.services.openItems.overdue()).toEqual([]);
    await app.services.consistency.run({ trigger: 'test' });
    expect(await dueTitles()).toEqual(['Heute fällig: Rechnung prüfen']);
  });
});

describe('Timeline days follow the local day (#77)', () => {
  it('puts an entry created at 00:30 Berlin time on the local day', async () => {
    const item = await createItem('Nachts angelegt', '2026-10-10');
    app.services.ctx.database.sqlite.prepare('UPDATE open_items SET created_at = ? WHERE id = ?').run('2026-09-30T22:30:00.000Z', item.id);

    setDefaultTimeZone('Europe/Berlin');
    const created = (await app.ok('timeline:get', {})).find((e) => e.id === `task:${item.id}:created`)!;
    expect(created.date).toBe('2026-10-01');
    expect(created.year).toBe(2026);
    expect((await app.ok('timeline:get', { from: '2026-10-01', to: '2026-10-01' })).map((e) => e.id)).toEqual([`task:${item.id}:created`]);

    setDefaultTimeZone('America/New_York');
    expect((await app.ok('timeline:get', {})).find((e) => e.id === `task:${item.id}:created`)!.date).toBe('2026-09-30');
  });
});
