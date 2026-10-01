import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const userText = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? '';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

describe('Kein stiller Rückfall auf den zuletzt genannten offenen Punkt (#40)', () => {
  it('„Erinnere mich am 15.11. an den Zahnarzt“ hängt nicht an „PoC vorstellen“, sondern legt einen eigenen Punkt an', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /^Offen: PoC/.test(userText(input))
        ? intent({ intent: 'open_item_new', openItem: { title: 'PoC vorstellen', responsible: 'Anna', dueAt: '2026-10-31' } })
        : intent({ intent: 'reminder_create', reminder: { targetHint: 'Zahnarzt anrufen', title: 'Zahnarzt anrufen', remindAt: '2026-11-15' } }),
    );
    const r1 = await send('Offen: PoC vorstellen');
    const poc = (await app.ok('openItems:list', {}))[0]!;

    await send('Erinnere mich am 15.11. an den Zahnarzt', r1.conversationId);

    const rem = (await app.ok('reminders:list', {}))[0]!;
    expect(rem.targetId).not.toBe(poc.id);
    const items = await app.ok('openItems:list', {});
    expect(items.map((i) => i.title).sort()).toEqual(['PoC vorstellen', 'Zahnarzt anrufen']);
    expect(rem.targetId).toBe(items.find((i) => i.title === 'Zahnarzt anrufen')!.id);
  });

  it('„Die Steuererklärung ist erledigt“ schlägt nicht vor, „PoC vorstellen“ zu schließen, sondern fragt nach', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /^Offen: PoC/.test(userText(input))
        ? intent({ intent: 'open_item_new', openItem: { title: 'PoC vorstellen', responsible: 'Anna', dueAt: '2026-10-31' } })
        : intent({ intent: 'open_item_close', openItem: { targetHint: 'Steuererklärung' } }),
    );
    const r1 = await send('Offen: PoC vorstellen');

    const r2 = await send('Die Steuererklärung ist erledigt', r1.conversationId);

    expect(r2.assistantMessage.actions).toHaveLength(0);
    expect(r2.assistantMessage.content).toContain('Zu „Steuererklärung“ finde ich keinen aktiven Punkt');
  });

  it('ohne eigenen Hinweis („der ist erledigt“, „erinnere mich daran“) gilt der zuletzt genannte Punkt', async () => {
    app.llm.down = true;
    const r1 = await send('Offener Punkt: Angebot Müller prüfen');
    await send('Anna', r1.conversationId);
    const item = (await app.ok('openItems:list', {}))[0]!;

    const r3 = await send('Erinnere mich nächsten Montag daran', r1.conversationId);
    expect((await app.ok('reminders:list', {}))[0]!.targetId).toBe(item.id);
    expect(r3.assistantMessage.content).toContain('Offener Punkt: Angebot Müller prüfen');

    const r4 = await send('Der Punkt ist erledigt', r1.conversationId);
    expect((r4.assistantMessage.actions[0]!.proposedParameters as { openItemId: string }).openItemId).toBe(item.id);
  });

  it('ein ausdrücklich genannter Punkt hat Vorrang vor einer offenen Rückfrage', async () => {
    const budget = await app.ok('openItems:create', { title: 'Budget planen', priority: 'normal', sourceIds: [], confidence: 0.9 });
    app.llm.on('ChatIntent', (_s, input) =>
      /^Offen: PoC/.test(userText(input))
        ? intent({ intent: 'open_item_new', openItem: { title: 'PoC vorstellen' } })
        : intent({ intent: 'open_item_update', openItem: { targetHint: 'Budget', responsible: 'Ben' } }),
    );
    const r1 = await send('Offen: PoC vorstellen');
    expect(r1.assistantMessage.content).toMatch(/Wer ist verantwortlich/);

    await send('Beim Budget ist Ben verantwortlich', r1.conversationId);

    const items = await app.ok('openItems:list', {});
    expect(items.find((i) => i.id === budget.id)!.responsibleName).toBe('Ben');
    expect(items.find((i) => i.title === 'PoC vorstellen')!.responsibleName).toBeNull();
  });
});
