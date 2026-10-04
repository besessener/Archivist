import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { extractedDecision, intent, userText } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

describe('rule-based chat keeps the conversation state across captures', () => {
  it('keeps „Trotzdem fortfahren“ for the rest of the day after the held message captured a decision', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Postgres/.test(userText(input))
        ? intent({
            intent: 'decision_new',
            decisionCertainty: 'clear',
            decision: extractedDecision({
              decisionText: 'Wir nutzen Postgres.',
              topic: 'Datenbank',
              topicIsProject: false,
              decidedAt: '2026-10-01',
              participants: ['Anna'],
            }),
          })
        : intent({ intent: 'smalltalk' }),
    );
    app.llm.textUsage = { input: 1500, output: 500, cached: 0 };
    await app.services.llm.complete({ instructions: 'Test', input: 'Hallo', purpose: 'Verbrauch' });
    await app.ok('settings:update', { llm: { dailyTokenCap: 1000 } });

    const asked = await send('Wir haben am 1.10.2026 mit Anna entschieden, Postgres zu nutzen.');
    expect(asked.assistantMessage.intent).toBe('token_cap');
    const continued = await send('Trotzdem fortfahren', asked.conversationId);
    expect(continued.assistantMessage.content).toContain('Die Entscheidung ist gespeichert.');

    const later = await send('Hallo', asked.conversationId);
    expect(later.assistantMessage.intent).not.toBe('token_cap');
  });

  it('mentions the missing LLM only once, also when the messages capture open items', async () => {
    const offline = await createTestApp({ configured: false });
    try {
      const first = await offline.ok('chat:send', { text: 'Offener Punkt: Angebot prüfen' });
      const replies = [first];
      for (const text of ['Offener Punkt: Rechnung bezahlen', 'Offener Punkt: Dach reparieren'])
        replies.push(await offline.ok('chat:send', { text, conversationId: first.conversationId }));

      expect(replies.map((reply) => reply.assistantMessage.content.includes('regelbasiert'))).toEqual([true, false, false]);
    } finally {
      await offline.cleanup();
    }
  });
});

describe('deferred requests run once the duplicate question is answered', () => {
  beforeEach(() => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Kaffee/.test(userText(input))
        ? {
            intents: [
              intent({ intent: 'open_item_new', segment: 'Angebot Müller prüfen.', openItem: { title: 'Angebot Müller prüfen' } }),
              intent({ intent: 'note_capture', segment: 'Notiz: Kaffee kaufen', note: 'Kaffee kaufen' }),
            ],
          }
        : intent({ intent: 'open_item_new', openItem: { title: 'Angebot Müller prüfen' } }),
    );
  });

  async function askDuplicate(): Promise<string> {
    const first = await send('Angebot Müller prüfen');
    const asked = await send('Angebot Müller prüfen. Notiz: Kaffee kaufen', first.conversationId);
    expect(asked.assistantMessage.content).toMatch(/Gibt es schon: ‚Angebot Müller prüfen‘ – ergänzen oder neu anlegen\?/);
    expect(asked.assistantMessage.content).toMatch(/Danach erledige ich noch:\n• Notiz/);
    return first.conversationId;
  }

  const noteSaved = async () => (await app.ok('search:global', { query: 'Kaffee kaufen', limit: 5 })).some((hit) => hit.type === 'note');

  it('saves the deferred note after „Neu anlegen“', async () => {
    const conversationId = await askDuplicate();

    const answered = await send('Neu anlegen', conversationId);

    expect(await app.ok('openItems:list', {})).toHaveLength(2);
    expect(answered.assistantMessage.content).toContain('Wer ist verantwortlich?');
    expect(answered.assistantMessage.content).toContain('Notiz gespeichert');
    expect(await noteSaved()).toBe(true);
  });

  it('saves the deferred note right after „Ergänzen“, not only with the next message', async () => {
    const conversationId = await askDuplicate();

    const answered = await send('Ergänzen', conversationId);

    expect(await app.ok('openItems:list', {})).toHaveLength(1);
    expect(answered.assistantMessage.content).toContain('Notiz gespeichert');
    expect(await noteSaved()).toBe(true);
  });
});
