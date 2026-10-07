import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

async function createLeaseDecision() {
  await app.ok('decisions:create', {
    title: 'Mietvertrag Bern behalten',
    decisionText: 'Wir behalten den Mietvertrag in Bern wegen der günstigen Miete.',
    topic: 'Wohnen',
    decidedAt: '2026-03-01',
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });
  await Promise.all(app.services.decisions.list().map((d) => app.services.decisions.reindex(d.id)));
}

const challenge = (overrides: object = {}) => ({
  summary: 'Eine Kündigung widerspricht deiner Entscheidung vom März.',
  against: [{ statement: 'Du wolltest den Vertrag wegen der günstigen Miete behalten.', sourceIds: ['S1'] }],
  supporting: [],
  affected: [{ statement: 'Erfunden ohne Beleg.', sourceIds: ['S9'] }],
  uncertainties: [],
  missingInformation: ['Kündigungsfrist'],
  confidence: 0.8,
  ...overrides,
});

describe('Challenging an idea against the archive', () => {
  it('answers with cited points for and against, drops points without a valid source, and saves nothing', async () => {
    await createLeaseDecision();
    app.llm.on('ChatIntent', () => ({
      intents: [
        {
          intent: 'idea_challenge',
          confidence: 0.9,
          rationale: 'test',
          query: 'Mietvertrag Bern kündigen',
          segment: 'Ich überlege, den Mietvertrag in Bern zu kündigen',
        },
      ],
    }));
    app.llm.on('IdeaChallenge', () => challenge());
    const decisionsBefore = (await app.ok('decisions:list', {})).length;

    const reply = await app.ok('chat:send', { text: 'Ich überlege, den Mietvertrag in Bern zu kündigen' });

    const message = reply.assistantMessage;
    const content = message.content;
    expect(content).toContain('**Dagegen spricht**');
    expect(content).toContain('Du wolltest den Vertrag wegen der günstigen Miete behalten. [1]');
    expect(content).not.toContain('Erfunden ohne Beleg');
    expect(content).toContain('1 Aussage(n) des Modells ohne gültigen Quellenbeleg wurden verworfen.');
    expect(content).toContain('Fehlt: Kündigungsfrist');
    expect(message.sources.map((s) => s.title)).toContain('1. Mietvertrag Bern behalten');
    expect(await app.ok('decisions:list', {})).toHaveLength(decisionsBefore);
    const call = app.llm.calls.find((c) => c.schema === 'IdeaChallenge')!;
    expect(call.input).toContain('Idee: Ich überlege, den Mietvertrag in Bern zu kündigen');
    expect(call.input).toContain('Mietvertrag in Bern wegen der günstigen Miete');
  });

  it('shows the found sources as not cited when no point has a valid source', async () => {
    await createLeaseDecision();
    app.llm.on('ChatIntent', () => ({ intents: [{ intent: 'idea_challenge', confidence: 0.9, rationale: 'test', query: 'Mietvertrag Bern kündigen' }] }));
    app.llm.on('IdeaChallenge', () => challenge({ against: [], affected: [] }));

    const reply = await app.ok('chat:send', { text: 'Spricht etwas dagegen, den Mietvertrag in Bern zu kündigen?' });

    const message = reply.assistantMessage;
    expect(message.content).toContain('enthalten nichts Belegtes');
    expect(message.sources.map((s) => s.title)).toContain('1. Mietvertrag Bern behalten (gefunden, nicht zitiert)');
  });
});
