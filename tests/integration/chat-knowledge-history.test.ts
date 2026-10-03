import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

describe('Knowledge answers know the conversation (#156)', () => {
  it('hands the earlier turns to the answer prompt so „daran“ can be resolved', async () => {
    await app.ok('decisions:create', {
      title: 'Hosting wechseln',
      decisionText: 'Wir wechseln das Hosting zu Anbieter Blau.',
      topic: 'Hosting',
      decidedAt: '2026-03-01',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    await Promise.all(app.services.decisions.list().map((d) => app.services.decisions.reindex(d.id)));
    app.llm.on('ChatIntent', () => ({ intents: [{ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Hosting Anbieter Blau' }] }));
    app.llm.on('KnowledgeAnswer', () => ({
      answer: 'Anna.',
      facts: [],
      uncertainties: [],
      contradictions: [],
      missingInformation: [],
      usedSourceIds: ['S1'],
      confidence: 0.8,
    }));

    const first = await app.ok('chat:send', { text: 'Was haben wir zum Hosting entschieden?' });
    await app.ok('chat:send', { text: 'Und wer war daran beteiligt?', conversationId: first.conversationId });

    const input = app.llm.calls.filter((c) => c.schema === 'KnowledgeAnswer').at(-1)!.input;
    expect(input).toContain('=== BISHERIGER VERLAUF');
    expect(input).toContain('Benutzer: Was haben wir zum Hosting entschieden?');
    expect(input).not.toMatch(/BISHERIGER VERLAUF[^]*Und wer war daran beteiligt\?[^]*ENDE VERLAUF/);
  });
});
