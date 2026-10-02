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

describe('Accurate matching of open items in the chat (#39)', () => {
  it('ambiguous: asks „Meinst du ‚Vertrag prüfen‘ oder ‚Vertrag kündigen‘?“ and after the choice closes exactly that one', async () => {
    await item('Vertrag prüfen');
    const cancelContract = await item('Vertrag kündigen');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_close', openItem: { targetHint: 'Vertrag' } }));

    const r1 = await send('Der Vertrag ist erledigt');

    expect(r1.assistantMessage.content).toMatch(/^Meinst du ‚Vertrag (prüfen|kündigen)‘ oder ‚Vertrag (prüfen|kündigen)‘\?$/);
    expect(r1.assistantMessage.actions).toHaveLength(0);
    expect([...(r1.assistantMessage.quickReplies ?? [])].sort()).toEqual(['Vertrag kündigen', 'Vertrag prüfen']);

    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await send('Vertrag kündigen', r1.conversationId);

    expect(closeTarget(r2)).toBe(cancelContract.id);
    expect(r2.assistantMessage.content).toContain('Vertrag kündigen');
  });

  it('without an LLM: „Der PoC ist erledigt, schließ den Punkt bitte“ matches „PoC vorstellen“', async () => {
    const poc = await item('PoC vorstellen');
    await item('Steuer');
    app.llm.down = true;
    const r = await send('Der PoC ist erledigt, schließ den Punkt bitte');
    expect(closeTarget(r)).toBe(poc.id);
  });

  it('„TÜV“ matches as a whole word', async () => {
    await item('Präsentation für Kunde X vorbereiten');
    const carInspection = await item('Auto zum TÜV bringen');
    app.llm.on('ChatIntent', () => intent({ intent: 'reminder_create', reminder: { targetHint: 'TÜV', remindAt: '2026-11-02' } }));
    await send('Erinnere mich am 2.11. an den TÜV');
    expect((await app.ok('reminders:list', {}))[0]!.targetId).toBe(carInspection.id);
  });

  it('no match above the threshold: „Server“ does not match „Steuer“, the chat asks back', async () => {
    await item('Steuer');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_close', openItem: { targetHint: 'Server' } }));
    const r = await send('Der Server-Punkt ist erledigt');
    expect(r.assistantMessage.actions).toHaveLength(0);
    expect(r.assistantMessage.content).toContain('Welchen offenen Punkt');
  });
});
