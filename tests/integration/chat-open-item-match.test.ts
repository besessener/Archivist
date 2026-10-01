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
const closeTarget = (r: Awaited<ReturnType<typeof send>>) =>
  (r.assistantMessage.actions[0]?.proposedParameters as { openItemId?: string } | undefined)?.openItemId;

describe('Treffsicheres Matching offener Punkte im Chat (#39)', () => {
  it('mehrdeutig: fragt „Meinst du ‚Vertrag prüfen‘ oder ‚Vertrag kündigen‘?“ und schließt nach der Auswahl genau diesen', async () => {
    await item('Vertrag prüfen');
    const kuendigen = await item('Vertrag kündigen');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_close', openItem: { targetHint: 'Vertrag' } }));

    const r1 = await send('Der Vertrag ist erledigt');

    expect(r1.assistantMessage.content).toMatch(/^Meinst du ‚Vertrag (prüfen|kündigen)‘ oder ‚Vertrag (prüfen|kündigen)‘\?$/);
    expect(r1.assistantMessage.actions).toHaveLength(0);
    expect([...(r1.assistantMessage.quickReplies ?? [])].sort()).toEqual(['Vertrag kündigen', 'Vertrag prüfen']);

    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await send('Vertrag kündigen', r1.conversationId);

    expect(closeTarget(r2)).toBe(kuendigen.id);
    expect(r2.assistantMessage.content).toContain('Vertrag kündigen');
  });

  it('ohne LLM: „Der PoC ist erledigt, schließ den Punkt bitte“ trifft „PoC vorstellen“', async () => {
    const poc = await item('PoC vorstellen');
    await item('Steuer');
    app.llm.down = true;
    const r = await send('Der PoC ist erledigt, schließ den Punkt bitte');
    expect(closeTarget(r)).toBe(poc.id);
  });

  it('„TÜV“ trifft als ganzes Wort', async () => {
    await item('Präsentation für Kunde X vorbereiten');
    const tuev = await item('Auto zum TÜV bringen');
    app.llm.on('ChatIntent', () => intent({ intent: 'reminder_create', reminder: { targetHint: 'TÜV', remindAt: '2026-11-02' } }));
    await send('Erinnere mich am 2.11. an den TÜV');
    expect((await app.ok('reminders:list', {}))[0]!.targetId).toBe(tuev.id);
  });

  it('kein Treffer über der Schwelle: „Server“ trifft nicht „Steuer“, der Chat fragt nach', async () => {
    await item('Steuer');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_close', openItem: { targetHint: 'Server' } }));
    const r = await send('Der Server-Punkt ist erledigt');
    expect(r.assistantMessage.actions).toHaveLength(0);
    expect(r.assistantMessage.content).toContain('Welchen offenen Punkt');
  });
});
