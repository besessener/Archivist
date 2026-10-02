import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  await app.ok('events:create', {
    title: 'Beitrag beim German Testing Day eingereicht',
    occurredAt: '2026-10-01',
    topic: 'Konferenzbeitrag',
    sourceIds: [],
  });
  // indexing the event runs in the background; wait until it shows up in search
  for (let i = 0; i < 50; i++) {
    if ((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'event')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
});
afterEach(async () => {
  await app.cleanup();
});

const question = 'Wann habe ich den Beitrag beim German Testing Day eingereicht?';

describe('Knowledge questions also find events (#48)', () => {
  it('passes the event with its date as a source to the LLM and in the answer', async () => {
    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'German Testing Day eingereicht' }));
    app.llm.on('KnowledgeAnswer', (_s, input) => {
      expect(input).toContain('Beitrag beim German Testing Day eingereicht');
      expect(input).toContain('2026-10-01');
      expect(input).toMatch(/\[S1\] \(event, 2026-10-01\)/);
      return {
        answer: 'Du hast den Beitrag am 1. Oktober 2026 eingereicht.',
        facts: [{ statement: 'Eingereicht am 2026-10-01.', sourceIds: ['S1'] }],
        uncertainties: [],
        contradictions: [],
        missingInformation: [],
        usedSourceIds: ['S1'],
        confidence: 0.9,
      };
    });
    const r = await app.ok('chat:send', { text: question });
    const m = r.assistantMessage;
    expect(m.content).not.toMatch(/finde ich im Archiv nichts/);
    expect(m.content).toContain('1. Oktober 2026');
    expect(m.sources[0]).toMatchObject({
      type: 'event',
      title: expect.stringContaining('German Testing Day'),
      date: expect.stringMatching(/^2026-10-01/),
    });
    expect(app.llm.calls.some((c) => c.schema === 'KnowledgeAnswer')).toBe(true);
  });

  it('shows the event with its date in the local hit list without an LLM', async () => {
    app.llm.down = true;
    const r = await app.ok('chat:send', { text: question });
    const m = r.assistantMessage;
    expect(m.content).toMatch(/lokale Trefferliste/);
    expect(m.content).toMatch(/Beitrag beim German Testing Day eingereicht\*\* \(event, 2026-10-01\)/);
    const src = m.sources.find((s) => s.type === 'event');
    expect(src).toMatchObject({ title: expect.stringContaining('German Testing Day'), date: expect.stringMatching(/^2026-10-01/) });
  });

  it('names events when nothing was found', async () => {
    app.llm.down = true;
    const r = await app.ok('chat:send', { text: 'Haben wir jemals über Vault gesprochen?' });
    expect(r.assistantMessage.content).toMatch(/Dazu habe ich unter den archivierten .*Ereignissen.* nichts gefunden/);
    // no absolute „there is nothing“: the reply names what was searched and that other wordings may exist (#164)
    expect(r.assistantMessage.content).toMatch(/gesucht nach „Haben wir jemals über Vault gesprochen\?“\)\. Das heißt nicht sicher/);
    expect(r.assistantMessage.sources).toHaveLength(0);
  });
});
