import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
};

describe('Chat: cancelling a running request (#151)', () => {
  it('a hanging classification is cancelled; nothing is saved and no rule-based fallback runs', async () => {
    app.llm.on('ChatIntent', () => new Promise(() => {}));
    const pending = app.ok('chat:send', { text: 'Wir haben entschieden, dass der Zaun grün wird.' });
    await waitFor(() => app.llm.calls.length > 0);

    expect(await app.ok('chat:cancel', {})).toEqual({ cancelled: 1 });
    const res = await pending;

    expect(res.assistantMessage.content).toBe('Abgebrochen.');
    expect(res.assistantMessage.intent).toBe('cancelled');
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    // a cancellation says nothing about the endpoint: no red status, no circuit breaker
    expect(app.services.llm.status().state).not.toBe('error');
    app.llm.on('ChatIntent', () => intent({ intent: 'smalltalk' }));
    const next = await app.ok('chat:send', { text: 'Hallo', conversationId: res.conversationId });
    expect(next.assistantMessage.intent).not.toBe('error');
  });

  it('keeps what is already done and skips the requests that did not start yet', async () => {
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({ intent: 'note_capture', segment: 'Notiz: Server läuft wieder.', note: 'Server läuft wieder' }),
        intent({ intent: 'knowledge_question', segment: 'Was gilt für den Zaun?', query: 'Zaun' }),
        intent({ intent: 'open_item_new', segment: 'Offen: Backup prüfen', openItem: { title: 'Backup prüfen' } }),
      ],
    }));
    await app.services.notes.create({ title: 'Zaun', content: 'Der Zaun wird grün gestrichen.' });
    app.llm.on('KnowledgeAnswer', () => new Promise(() => {}));
    const pending = app.ok('chat:send', { text: 'Notiz: Server läuft wieder. Was gilt für den Zaun? Offen: Backup prüfen' });
    await waitFor(() => app.llm.calls.some((c) => c.schema === 'KnowledgeAnswer'));

    const conv = (await app.ok('chat:conversations', {}))[0]!;
    expect(await app.ok('chat:cancel', { conversationId: conv.id })).toEqual({ cancelled: 1 });
    const res = await pending;

    expect(res.assistantMessage.content).toContain('Notiz gespeichert');
    expect(res.assistantMessage.content).toContain('Den Rest habe ich abgebrochen.');
    expect(await app.ok('openItems:list', {})).toHaveLength(0);
  });

  it('cancelling without a running request does nothing', async () => {
    expect(await app.ok('chat:cancel', {})).toEqual({ cancelled: 0 });
  });
});
