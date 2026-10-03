import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shortAnswer } from '../../packages/core/src/services/chat-state';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent, userText } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

/** Proposal that does not come from the chat (e.g. archive check): conversationId null. */
const foreignProposal = (conversationId: string | null = null) =>
  app.services.actions.propose({
    actionType: 'exclude_path',
    label: 'Ordner ausschließen: /tmp/x',
    rationale: 'Archivprüfung',
    confidence: 0.9,
    affectedEntities: [],
    requiredConfirmation: 'confirm',
    proposedParameters: { kind: 'dir', path: '/tmp/x' },
    conversationId,
  });

function proposedRelation(a: string, b: string) {
  const g = app.services.graph;
  return g.link(g.ensureEntity('topic', a).id, g.ensureEntity('project', b).id, 'relates_to', { confidence: 0.6, status: 'proposed' })!;
}

describe('„ja/ok/bitte“ confirms only proposals of this conversation (#37)', () => {
  it('new chat + „ja“: nothing happens, even when the archive check has a proposal (with LLM)', async () => {
    const foreign = foreignProposal();
    app.llm.on('ChatIntent', () => intent({ intent: 'proposal_confirm' }));

    const r = await send('ja');

    expect(r.assistantMessage.content).toContain('Es gibt hier keinen offenen Vorschlag');
    expect(app.services.actions.get(foreign.id).status).toBe('proposed');
  });

  it('new chat + „ja“ without an LLM: nothing happens', async () => {
    app.llm.down = true;
    const foreign = foreignProposal();

    const r = await send('ja, mach das');

    expect(r.assistantMessage.intent).toBe('proposal_confirm');
    expect(r.assistantMessage.content).toContain('Es gibt hier keinen offenen Vorschlag');
    expect(app.services.actions.get(foreign.id).status).toBe('proposed');
  });

  it('a proposal from another conversation is not confirmed', async () => {
    app.llm.down = true;
    const other = await send('Hallo');
    const foreign = foreignProposal(other.conversationId);

    const r = await send('ok');

    expect(r.assistantMessage.content).toContain('keinen offenen Vorschlag');
    expect(app.services.actions.get(foreign.id).status).toBe('proposed');
  });

  it('relation card + „ja“ confirms the relation; there is exactly one card per relation', async () => {
    const rel = proposedRelation('Hauskauf', 'Nordlicht');
    app.llm.on('ChatIntent', (_s, input) => (/^ja/.test(userText(input)) ? intent({ intent: 'proposal_confirm' }) : intent({ intent: 'relation_decide' })));

    const r1 = await send('Welche Beziehungen sind noch offen?');
    expect(r1.assistantMessage.actions).toHaveLength(1);
    expect(r1.assistantMessage.actions[0]).toMatchObject({ actionType: 'confirm_relation', status: 'proposed' });

    const r2 = await send('ja', r1.conversationId);

    expect(r2.assistantMessage.content).toContain('Erledigt');
    expect(app.services.graph.getRelation(rel.id)?.status).toBe('confirmed');
  });

  it('„Ablehnen“ on the relation card discards the relation', async () => {
    const rel = proposedRelation('Hauskauf', 'Nordlicht');
    app.llm.on('ChatIntent', () => intent({ intent: 'relation_decide' }));
    const r1 = await send('Welche Beziehungen sind noch offen?');

    await app.ok('actions:resolve', { decision: 'reject', actionId: r1.assistantMessage.actions[0]!.id });

    expect(app.services.graph.getRelation(rel.id)?.status).toBe('rejected');
  });

  it('„Bitte zeig mir …“ without an LLM is not a confirmation; „Nicht vergessen: …“ is not a rejection', async () => {
    proposedRelation('Hauskauf', 'Nordlicht');
    app.llm.on('ChatIntent', () => intent({ intent: 'relation_decide' }));
    const r1 = await send('Welche Beziehungen sind noch offen?');
    const card = r1.assistantMessage.actions[0]!;
    app.llm.down = true;

    const r2 = await send('Bitte zeig mir die Dokumente zu Hauskauf', r1.conversationId);
    const r3 = await send('Nicht vergessen: Gutachter anrufen', r1.conversationId);

    expect(r2.assistantMessage.intent).not.toBe('proposal_confirm');
    expect(r3.assistantMessage.intent).not.toBe('proposal_reject');
    expect(app.services.actions.get(card.id).status).toBe('proposed');
  });

  it('several open cards: asks „Welchen Vorschlag meinst du?“ and executes the chosen one', async () => {
    const relA = proposedRelation('Hauskauf', 'Nordlicht');
    const relB = proposedRelation('Steuer', 'Südwind');
    app.llm.on('ChatIntent', (_s, input) => (/^ja/.test(userText(input)) ? intent({ intent: 'proposal_confirm' }) : intent({ intent: 'relation_decide' })));
    const r1 = await send('Welche Beziehungen sind noch offen?');
    expect(r1.assistantMessage.actions).toHaveLength(2);

    const r2 = await send('ja', r1.conversationId);
    expect(r2.assistantMessage.content).toContain('Welchen Vorschlag meinst du?');
    expect(app.services.graph.getRelation(relA.id)?.status).toBe('proposed');
    expect(app.services.graph.getRelation(relB.id)?.status).toBe('proposed');

    const second = r1.assistantMessage.actions[1]!;
    const secondRel = (second.proposedParameters as { relationId: string }).relationId;
    const r3 = await send('2', r1.conversationId);

    expect(r3.assistantMessage.content).toContain('Erledigt');
    expect(app.services.graph.getRelation(secondRel)?.status).toBe('confirmed');
    const firstRel = (r1.assistantMessage.actions[0]!.proposedParameters as { relationId: string }).relationId;
    expect(app.services.graph.getRelation(firstRel)?.status).toBe('proposed');
  });
});

describe('shortAnswer', () => {
  it.each([
    ['ja', 'yes'],
    ['Ja, mach das!', 'yes'],
    ['ok', 'yes'],
    ['bitte', 'yes'],
    ['gerne, danke', 'yes'],
    ['nein', 'no'],
    ['nein danke', 'no'],
    ['lass das lieber', 'no'],
    ['Bitte zeig mir die Dokumente zu X', null],
    ['Nicht vergessen: Gutachter anrufen', null],
    ['ja, als Notiz', null],
    ['Okay, und wann war der Kickoff?', null],
  ])('%s → %s', (text, expected) => {
    expect(shortAnswer(text)).toBe(expected);
  });
});

describe('Only a clear „ja“ executes a card – not an LLM label (#199)', () => {
  it('a message the classifier calls an approval, but that is no „ja“, is asked back', async () => {
    const rel = proposedRelation('Hauskauf', 'Nordlicht');
    app.llm.on('ChatIntent', (_s, input) =>
      /Welche Beziehungen/.test(userText(input)) ? intent({ intent: 'relation_decide' }) : intent({ intent: 'proposal_confirm' }),
    );
    const r1 = await send('Welche Beziehungen sind noch offen?');

    const r2 = await send('Zeig mir vorher bitte noch die Zielordner', r1.conversationId);

    expect(app.services.graph.getRelation(rel.id)?.status).toBe('proposed');
    expect(r2.assistantMessage.content).toMatch(/Soll ich „.*“ ausführen\?/);

    await send('ja', r1.conversationId);
    expect(app.services.graph.getRelation(rel.id)?.status).toBe('confirmed');
  });

  it('after the question, an unrelated message does not execute the card', async () => {
    const rel = proposedRelation('Hauskauf', 'Nordlicht');
    app.llm.on('ChatIntent', (_s, input) =>
      /Welche Beziehungen/.test(userText(input)) ? intent({ intent: 'relation_decide' }) : intent({ intent: 'proposal_confirm' }),
    );
    const r1 = await send('Welche Beziehungen sind noch offen?');
    await send('Mach weiter wie im Dokument beschrieben', r1.conversationId);
    await send('Und noch etwas anderes', r1.conversationId);
    expect(app.services.graph.getRelation(rel.id)?.status).toBe('proposed');
  });
});
