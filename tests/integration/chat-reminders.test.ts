import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});
const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });
const item = (title: string) => app.ok('openItems:create', { title, priority: 'normal', sourceIds: [], confidence: 0.9 });
const getItem = async (id: string) => (await app.ok('openItems:list', {})).find((i) => i.id === id)!;

describe('Reliable reminders and follow-up questions for open items (#49)', () => {
  it('if something is still missing, the answer names the open question; „unbekannt“ answers it directly', async () => {
    app.llm.down = true;
    const r1 = await send('Offener Punkt: Angebot prüfen');
    const r2 = await send('Anna', r1.conversationId);
    expect(r2.assistantMessage.content).toContain('Noch offen: Bis wann?');
    const r3 = await send('unbekannt', r1.conversationId);
    expect(r3.assistantMessage.content).toContain('Termin: unbekannt');
    const i = (await app.ok('openItems:list', {}))[0]!;
    expect(i.responsibleName).toBe('Anna');
    expect(i.dueUnknown).toBe(true);
  });

  it('„Anna, Termin unbekannt“ sets the responsible person and marks the due date as unknown', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Termin unbekannt/.test(input.split('Nachricht des Benutzers:\n')[1] ?? '')
        ? intent({ intent: 'open_item_update', openItem: { responsible: 'Anna' } })
        : intent({ intent: 'open_item_new', openItem: { title: 'Angebot prüfen' } }),
    );
    const r1 = await send('Offen: Angebot prüfen');
    await send('Anna, Termin unbekannt', r1.conversationId);
    const i = (await app.ok('openItems:list', {}))[0]!;
    expect(i.responsibleName).toBe('Anna');
    expect(i.dueUnknown).toBe(true);
    expect(i.responsibleUnknown).toBe(false);
  });

  it("closing ends the item's reminders, undo restores them; reminderAt follows the next reminder", async () => {
    const poc = await item('PoC vorstellen');
    app.services.reminders.create({ targetType: 'open_item', targetId: poc.id, title: 'PoC', remindAt: '2026-11-20' });
    app.services.reminders.create({ targetType: 'open_item', targetId: poc.id, title: 'PoC', remindAt: '2026-11-10' });
    expect((await getItem(poc.id)).reminderAt).toBe('2026-11-10');

    app.services.openItems.close(poc.id, 'resolved', { confirmed: true });
    expect((await app.ok('reminders:list', {})).every((r) => r.status === 'dismissed')).toBe(true);
    expect((await getItem(poc.id)).reminderAt).toBeNull();

    const entry = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((e) => e.action === 'open_item.close')!;
    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(true);
    expect((await app.ok('reminders:list', {})).every((r) => r.status === 'pending')).toBe(true);
    expect((await getItem(poc.id)).reminderAt).toBe('2026-11-10');

    app.services.reminders.dismiss(app.services.reminders.list().find((r) => r.remindAt === '2026-11-10')!.id);
    expect((await getItem(poc.id)).reminderAt).toBe('2026-11-20');
  });

  it('postponing also finds reminders that have already fired', async () => {
    const poc = await item('PoC vorstellen');
    app.services.reminders.create({ targetType: 'open_item', targetId: poc.id, title: 'PoC vorstellen', remindAt: '2020-01-01' });
    app.services.reminders.checkDue();
    expect((await app.ok('reminders:list', {}))[0]!.status).toBe('fired');
    app.llm.on('ChatIntent', () => intent({ intent: 'reminder_snooze', reminder: { targetHint: 'PoC', remindAt: '2026-11-15' } }));

    const r = await send('Erinnere mich am 15.11. nochmal an den PoC');

    expect(r.assistantMessage.content).toContain('Erinnerung verschoben auf 2026-11-15');
    const list = await app.ok('reminders:list', {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'pending', remindAt: '2026-11-15' });
    expect((await getItem(poc.id)).reminderAt).toBe('2026-11-15');
  });
});
