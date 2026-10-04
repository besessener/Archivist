import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneByRetention } from '../../packages/core/src/composition/lifecycle';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const sqlite = () => app.services.database.sqlite;

function insertTransmission(id: string, at: string): void {
  sqlite()
    .prepare("INSERT INTO llm_transmissions (id, at, purpose, model, endpoint, bytes, document_ids, preview) VALUES (?, ?, 'Test', 'm', 'e', 1, '[]', '')")
    .run(id, at);
}

const transmissionIds = () => (sqlite().prepare('SELECT id FROM llm_transmissions ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id);
const notificationTitles = () => (sqlite().prepare('SELECT title FROM notifications ORDER BY title').all() as Array<{ title: string }>).map((row) => row.title);

function notification(title: string, { readDaysAgo }: { readDaysAgo: number | null }): void {
  const created = app.services.notifications.create({ title, description: 'x', type: 'scan_done' });
  if (readDaysAgo === null) return;
  sqlite().prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(daysAgo(readDaysAgo), created.id);
}

describe('Retention of bookkeeping tables (#208)', () => {
  it('removes transmission entries older than logs.retentionDays and keeps newer ones', () => {
    app.services.settings.update({ logs: { retentionDays: 30 } });
    insertTransmission('old', daysAgo(45));
    insertTransmission('recent', daysAgo(5));

    pruneByRetention(app.services);

    expect(transmissionIds()).toEqual(['recent']);
  });

  it('follows the configured retention period', () => {
    app.services.settings.update({ logs: { retentionDays: 3 } });
    insertTransmission('old', daysAgo(5));
    insertTransmission('recent', daysAgo(1));

    pruneByRetention(app.services);

    expect(transmissionIds()).toEqual(['recent']);
  });

  it('removes notifications that were read long ago, never unread ones', () => {
    app.services.settings.update({ logs: { retentionDays: 30 } });
    notification('alt und gelesen', { readDaysAgo: 40 });
    notification('kürzlich gelesen', { readDaysAgo: 2 });
    notification('ungelesen', { readDaysAgo: null });

    pruneByRetention(app.services);

    expect(notificationTitles()).toEqual(['kürzlich gelesen', 'ungelesen']);
  });

  it('keeps a notification snoozed for longer than the retention period, so it comes back as itself (#79)', async () => {
    app.services.settings.update({ logs: { retentionDays: 30 } });
    const snoozed = app.services.notifications.create({
      title: 'Frist prüfen',
      description: 'x',
      type: 'scan_done',
      proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
    });
    notification('alt und gelesen', { readDaysAgo: 40 });
    await app.ok('notifications:snooze', { id: snoozed.id, remindAt: new Date(Date.now() + 60 * DAY_MS).toISOString() });
    sqlite().prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(daysAgo(40), snoozed.id);

    pruneByRetention(app.services);
    app.services.reminders.checkDue(new Date(Date.now() + 61 * DAY_MS));

    expect(notificationTitles()).toEqual(['Frist prüfen']);
    expect(app.services.notifications.get(snoozed.id)).toMatchObject({ readAt: null, resolvedAt: null, proposedActions: [{ label: 'Inbox öffnen' }] });
  });

  it('leaves the audit log, chat messages and agent actions alone', async () => {
    app.services.settings.update({ logs: { retentionDays: 1 } });
    sqlite().prepare('UPDATE audit_log SET at = ?').run(daysAgo(400));
    const count = (table: string) => (sqlite().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    await app.ok('chat:send', { text: 'Hallo' });
    const before = { audit: count('audit_log'), conversations: count('conversations'), actions: count('agent_actions') };

    pruneByRetention(app.services);

    expect({ audit: count('audit_log'), conversations: count('conversations'), actions: count('agent_actions') }).toEqual(before);
  });
});

describe('Transmission purpose without file names (#208)', () => {
  it('names the document by its id, not by its file name', async () => {
    app.llm.on('DocumentClassification', () => classification({ title: 'Vertrag', summary: 'Ein Vertrag', categoryPath: 'Privat/wohnen' }));
    const imported = await app.ok('documents:import', { paths: [app.file('in/geheimer-mietvertrag-mueller.txt', 'Mietvertrag für die Wohnung.')] });
    await app.services.jobs.whenIdle();
    const id = imported.imported[0]!.id;

    const purposes = (await app.ok('llm:transmissions', { limit: 100 })).map((entry) => entry.purpose);

    expect(purposes).toContain(`Dokumentklassifikation (${id})`);
    expect(purposes.join('\n')).not.toContain('mietvertrag-mueller');
  });
});
