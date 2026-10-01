import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const decisionEx = (over: Record<string, unknown> = {}) => ({ participants: [], alternatives: [], unknownFields: [], confidence: 0.85, ...over });
const userText = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? '';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });
const mk = (decisionText: string, topic: string, decidedAt: string) =>
  app.ok('decisions:create', {
    decisionText,
    title: decisionText,
    topic,
    decidedAt,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

describe('Unsichere Entscheidungen nie ungefragt speichern (#44)', () => {
  it('fragt auch dann nach, wenn schon ein Entscheidungs-Entwurf offen ist, und ergänzt den Entwurf nicht', async () => {
    app.llm.on('ChatIntent', (_s, input) => {
      if (/prod-plat/.test(userText(input)))
        return intent({
          intent: 'decision_new',
          decisionCertainty: 'clear',
          decision: decisionEx({ decisionText: 'prod-plat pausiert', topic: 'prod-plat', topicIsProject: false }),
        });
      return intent({
        intent: 'decision_new',
        segment: 'vielleicht den Anbieter wechseln',
        decisionCertainty: 'unsure',
        decision: decisionEx({ decisionText: 'Anbieter wechseln', title: 'Anbieter wechseln' }),
      });
    });
    const r1 = await send('Wir haben entschieden, prod-plat zu pausieren.');
    expect(r1.assistantMessage.content).toContain('Entwurf');
    const draft = (await app.ok('decisions:list', {}))[0]!;

    const r2 = await send('Wir sollten vielleicht den Anbieter wechseln.', r1.conversationId);

    expect(r2.assistantMessage.content).toMatch(/nicht sicher, ob das eine getroffene \*\*Entscheidung\*\*/);
    const all = await app.ok('decisions:list', {});
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(draft.id);
    expect(all[0]!.decisionText).toBe('prod-plat pausiert');
  });
});

describe('„ersetzt“ ohne Thema trifft keine fremde Entscheidung (#44)', () => {
  const supersede = () =>
    intent({
      intent: 'decision_supersede',
      decisionCertainty: 'clear',
      decision: decisionEx({ decisionText: 'Urlaub im Juli', title: 'Urlaub', decidedAt: '2026-05-01', participants: ['Anna'], unknownFields: ['topic'] }),
    });

  it('schlägt ohne eindeutigen Treffer nichts vor, sondern fragt „Welche Entscheidung wird ersetzt?“', async () => {
    const kafka = await mk('Wir nutzen Kafka', 'Messaging', '2026-01-10');
    const urlaub = await mk('Urlaub im Juni', 'Urlaub', '2026-01-05');
    app.llm.on('ChatIntent', supersede);

    const r = await send('Neue Entscheidung: Urlaub im Juli, ersetzt die alte.');

    expect(r.assistantMessage.content).toContain('Welche Entscheidung wird ersetzt?');
    expect(r.assistantMessage.actions.some((a) => a.actionType === 'supersede_decision')).toBe(false);
    const list = r.assistantMessage.content.split('Welche Entscheidung wird ersetzt?')[1]!;
    const pos = list.split('\n').findIndex((l) => l.includes('Urlaub im Juni'));
    expect(pos).toBeGreaterThan(0);

    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await send(`${pos}`, r.conversationId);

    const action = r2.assistantMessage.actions[0]!;
    expect(action).toMatchObject({ actionType: 'supersede_decision', status: 'proposed' });
    expect((action.proposedParameters as { oldDecisionId: string }).oldDecisionId).toBe(urlaub.id);
    expect((await app.ok('decisions:get', { id: kafka.id })).status).toBe('active');
    expect((await app.ok('decisions:get', { id: urlaub.id })).status, 'erst nach Bestätigung').toBe('active');
  });

  it('„keine“ beendet die Rückfrage ohne Vorschlag', async () => {
    await mk('Wir nutzen Kafka', 'Messaging', '2026-01-10');
    app.llm.on('ChatIntent', supersede);
    const r = await send('Neue Entscheidung: Urlaub im Juli, ersetzt die alte.');
    const r2 = await send('keine', r.conversationId);
    expect(r2.assistantMessage.content).toContain('keine Entscheidung als überholt');
    expect(app.services.actions.list('proposed').some((a) => a.actionType === 'supersede_decision')).toBe(false);
  });

  it('mit eindeutigem Thema wird die passende Entscheidung direkt vorgeschlagen', async () => {
    await mk('Wir nutzen Kafka', 'Messaging', '2026-01-10');
    const urlaub = await mk('Urlaub im Juni', 'Urlaub', '2026-01-05');
    app.llm.on('ChatIntent', () =>
      intent({
        intent: 'decision_supersede',
        topic: 'Urlaub',
        decisionCertainty: 'clear',
        decision: decisionEx({ decisionText: 'Urlaub im Juli', title: 'Urlaub Juli', topic: 'Urlaub', decidedAt: '2026-05-01', participants: ['Anna'] }),
      }),
    );
    const r = await send('Urlaub im Juli statt Juni, ersetzt die alte Entscheidung.');
    const sup = r.assistantMessage.actions.filter((a) => a.actionType === 'supersede_decision');
    expect(sup).toHaveLength(1);
    expect((sup[0]!.proposedParameters as { oldDecisionId: string }).oldDecisionId).toBe(urlaub.id);
  });
});
