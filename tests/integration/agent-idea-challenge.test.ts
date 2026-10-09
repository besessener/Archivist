import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, lastToolOutput, scriptedTurns, sentText } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

async function leaseDecision() {
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
  });
  await Promise.all(app.services.decisions.list().map((d) => app.services.decisions.reindex(d.id)));
}

const challenge = (overrides: object = {}) => ({
  summary: 'Eine Kündigung widerspricht deiner Entscheidung vom März.',
  against: [{ statement: 'Du wolltest den Vertrag wegen der günstigen Miete behalten.', sourceIds: ['S1'] }],
  supporting: [],
  affected: [],
  uncertainties: [],
  missingInformation: [],
  confidence: 0.8,
  ...overrides,
});

describe('Challenging an idea with the agent (#384)', () => {
  it('calls challenge_idea and gets the checked points for and against, without the intent flow', async () => {
    await leaseDecision();
    app.llm.on('IdeaChallenge', () => challenge());
    app.llm.agent = scriptedTurns({ calls: [{ name: 'challenge_idea', args: { idea: 'Den Mietvertrag in Bern kündigen' } }] }, () => ({
      text: 'Dagegen spricht deine Entscheidung (K1).',
    }));

    await app.ok('chat:send', { text: 'Ich überlege, den Mietvertrag in Bern zu kündigen' });

    expect(lastToolOutput(app)).toContain('**Dagegen spricht**');
    expect(lastToolOutput(app)).toContain('Du wolltest den Vertrag wegen der günstigen Miete behalten. [1]');
    expect(app.llm.calls.filter((c) => c.schema === 'ChatIntent')).toHaveLength(0);
    const call = app.llm.calls.find((c) => c.schema === 'IdeaChallenge')!;
    expect(call.input).toContain('Idee: Den Mietvertrag in Bern kündigen');
  });

  it('does not hand the model a document that is not shared, not even its title', async () => {
    const lease = await archived(app, { name: 'mietvertrag-geheim.txt', content: 'Mietvertrag Bern: Kündigungsfrist drei Monate.', folder: 'Privat/wohnen' });
    await app.ok('documents:setLlmExcluded', { id: lease, excluded: true });
    app.llm.on('IdeaChallenge', () => challenge());
    app.llm.agent = scriptedTurns({ calls: [{ name: 'challenge_idea', args: { idea: 'Mietvertrag Bern kündigen' } }] }, () => ({ text: 'Erledigt.' }));

    await app.ok('chat:send', { text: 'Spricht etwas dagegen, den Mietvertrag in Bern zu kündigen?' });

    expect(lastToolOutput(app)).toContain('nicht freigegeben');
    expect(sentText(app)).not.toContain('mietvertrag-geheim');
    expect(sentText(app)).not.toContain('Kündigungsfrist drei Monate');
  });
});

describe('Verified answers for the agent', () => {
  it('do not hand the model a document that is not shared, not even its title', async () => {
    const lease = await archived(app, { name: 'mietvertrag-geheim.txt', content: 'Mietvertrag Bern: Kündigungsfrist drei Monate.', folder: 'Privat/wohnen' });
    await app.ok('documents:setLlmExcluded', { id: lease, excluded: true });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'verified_answer', args: { question: 'Welche Kündigungsfrist hat der Mietvertrag Bern?' } }] }, () => ({
      text: 'Erledigt.',
    }));

    await app.ok('chat:send', { text: 'Welche Kündigungsfrist hat der Mietvertrag Bern?' });

    expect(lastToolOutput(app)).toContain('nicht freigegeben');
    expect(sentText(app)).not.toContain('mietvertrag-geheim');
    expect(sentText(app)).not.toContain('Kündigungsfrist drei Monate');
  });
});
