import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const decide = (decisionText: string, decidedAt: string) =>
  app.ok('decisions:create', {
    title: decisionText,
    decisionText,
    topic: 'Hosting',
    decidedAt,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

describe('Knowledge answers and outdated decisions (#170)', () => {
  it('list a revoked decision after the current one, even if it matches the question better', async () => {
    const old = await decide('Hosting bei Anbieter Rot, Hosting bei Anbieter Rot', '2026-01-10');
    await decide('Wir wechseln das Hosting zu Anbieter Blau.', '2026-03-01');
    app.services.decisions.revoke(old.id, { confirmed: true });
    await Promise.all(app.services.decisions.list().map((d) => app.services.decisions.reindex(d.id)));
    app.llm.on('ChatIntent', () => ({ intents: [{ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Hosting Anbieter Rot' }] }));
    app.llm.on('KnowledgeAnswer', () => ({
      answer: 'Antwort.',
      facts: [],
      uncertainties: [],
      contradictions: [],
      missingInformation: [],
      usedSourceIds: ['S1', 'S2'],
      confidence: 0.8,
    }));

    const reply = await app.ok('chat:send', { text: 'Welches Hosting nutzen wir?' });

    const titles = (reply.assistantMessage.sources ?? []).map((source) => source.title);
    expect(titles[0]).toContain('Blau');
    expect(titles.at(-1)).toContain('Rot');
  });
});
