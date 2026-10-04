import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionTools } from '../../packages/core/src/agent/tools/knowledge-decisions';
import { emptyToolContext } from '../helpers/agent';
import { toolCaller, toolDepsOf } from '../helpers/agent-tools';
import { classification } from '../helpers/document-classifications';
import { extractedDecision, intent } from '../helpers/chat-intents';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const FASSADE = {
  title: 'Fassade streichen',
  decisionText: 'Die Fassade wird im Herbst gestrichen.',
  decidedAt: '2026-05-12',
  participants: [] as string[],
  kind: 'decided',
  evidence: 'Beschluss: Die Fassade wird im Herbst gestrichen.',
};

/** Imports and archives a document whose (fake) classification names the Fassade decision. */
async function archived(name: string): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({
      title: name,
      summary: `Zusammenfassung ${name}`,
      categoryPath: 'Privat/haus',
      docType: 'Protokoll',
      mainTopic: 'Hausverwaltung',
      decisions: [FASSADE],
    }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Protokoll ${name}. Beschluss: Die Fassade wird im Herbst gestrichen.`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'Privat/haus' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const proposedFor = async (documentId: string) =>
  (await app.ok('actions:list', { status: 'proposed' })).filter((a) => a.affectedEntities.some((e) => e.id === documentId));
const approve = (actionId: string) => app.ok('actions:resolve', { decision: 'approve', actionId, confirmed: true, strongConfirmed: false });

describe('Decisions are not recorded twice (#187)', () => {
  it('proposes „um Quelle ergänzen“ for the same decision in a second document and adds the source', async () => {
    const first = await archived('Protokoll Mai');
    const [recordAction] = await proposedFor(first);
    expect(recordAction!.actionType).toBe('record_decision');
    await approve(recordAction!.id);

    const second = await archived('Protokoll Juni');
    const [action] = await proposedFor(second);
    expect(action!.actionType).toBe('add_decision_source');
    expect(action!.label).toBe('Entscheidung „Fassade streichen“ um Quelle ergänzen');
    expect((await approve(action!.id)).status).toBe('executed');

    const decisions = await app.ok('decisions:list', {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.sourceIds).toEqual([first, second]);
    const supports = app.services.graph.relationsOf(decisions[0]!.id, { types: ['supports'] }).map((r) => r.sourceEntityId);
    expect(supports.sort()).toEqual([first, second].sort());
    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'decision.update' && e.trigger === 'agent_action')!;
    expect(entry.before).toMatchObject({ sourceIds: [first] });
    expect(entry.after).toMatchObject({ sourceIds: [first, second] });
  });

  it('adds the source instead of a second decision when a proposal was made before the decision existed', async () => {
    const first = await archived('Protokoll Mai');
    const second = await archived('Protokoll Juni');
    const [firstAction] = await proposedFor(first);
    const [secondAction] = await proposedFor(second);
    expect([firstAction!.actionType, secondAction!.actionType]).toEqual(['record_decision', 'record_decision']);

    await approve(firstAction!.id);
    await approve(secondAction!.id);

    const decisions = await app.ok('decisions:list', {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ status: 'confirmed', sourceIds: [first, second] });
  });

  it('the chat does not record the same decision again, spelled differently', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      intent({
        intent: 'decision_new',
        decisionCertainty: 'clear',
        decision: extractedDecision({
          decisionText: /GROSS/.test(input) ? 'WIR NEHMEN DAS ANGEBOT VON MÜLLER!' : 'Wir nehmen das Angebot von Müller.',
          topic: 'Dach',
          topicIsProject: false,
          decidedAt: '2026-09-01',
          participants: ['Anna'],
        }),
      }),
    );
    const first = await app.ok('chat:send', { text: 'Wir haben entschieden, das Angebot von Müller zu nehmen.' });
    expect(first.assistantMessage.content).toContain('Die Entscheidung ist gespeichert.');
    const second = await app.ok('chat:send', { conversationId: first.conversationId, text: 'GROSS: Wir haben entschieden, das Angebot von Müller zu nehmen.' });

    expect(second.assistantMessage.content).toContain('schon erfasst');
    const decisions = await app.ok('decisions:list', {});
    expect(decisions).toHaveLength(1);
    expect(second.assistantMessage.sources[0]!.id).toBe(decisions[0]!.id);
  });

  it('the chat completes an incomplete draft with the details of the re-stated decision', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      intent({
        intent: 'decision_new',
        decisionCertainty: 'clear',
        decision: extractedDecision({
          decisionText: 'Wir nehmen das Angebot von Müller.',
          topic: 'Dach',
          topicIsProject: false,
          ...(/Anna/.test(input) ? { decidedAt: '2026-05-03', participants: ['Anna'], rationale: 'Es ist am günstigsten.' } : {}),
        }),
      }),
    );
    const first = await app.ok('chat:send', { text: 'Wir nehmen das Angebot von Müller (Thema Dach).' });
    expect(first.assistantMessage.content).toContain('Wann wurde das entschieden?');

    const second = await app.ok('chat:send', { text: 'Am 3.5. haben Anna und ich entschieden: Wir nehmen das Angebot von Müller (Thema Dach).' });

    expect(second.assistantMessage.content).not.toContain('Wann wurde das entschieden?');
    const decisions = await app.ok('decisions:list', {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decidedAt: '2026-05-03', participants: ['Anna'], rationale: 'Es ist am günstigsten.', missingFields: [] });
  });

  it('a background run that re-states the user’s incomplete draft leaves the draft unchanged', async () => {
    app.llm.on('ChatIntent', () =>
      intent({
        intent: 'decision_new',
        decisionCertainty: 'clear',
        decision: extractedDecision({ decisionText: 'Wir nehmen das Angebot von Müller.', topic: 'Dach', topicIsProject: false }),
      }),
    );
    await app.ok('chat:send', { text: 'Wir nehmen das Angebot von Müller (Thema Dach).' });
    const [draft] = await app.ok('decisions:list', {});
    expect(draft!.status).toBe('draft');

    await toolCaller(decisionTools(toolDepsOf(app)), { ...emptyToolContext(), trigger: 'background' })('record_decision', {
      text: 'Wir nehmen das Angebot von Müller.',
      topic: 'Dach',
      decidedAt: '2026-05-03',
      participants: ['Anna'],
      rationale: 'Es ist am günstigsten.',
    });

    const decisions = await app.ok('decisions:list', {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ status: 'draft', decidedAt: draft!.decidedAt, participants: draft!.participants, rationale: draft!.rationale });
  });

  it('the same text on another topic is another decision, and a revoked one may be decided again', async () => {
    const base = {
      decisionText: 'Wir nehmen das Angebot von Müller.',
      decidedAt: '2026-09-01',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    };
    const first = await app.ok('decisions:create', { ...base, topic: 'Dach' });
    expect((await app.ok('decisions:create', { ...base, topic: 'Keller' })).id).not.toBe(first.id);

    const duplicate = await app.call('decisions:create', { ...base, topic: 'dach' });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.message).toMatch(/schon erfasst/);

    await app.ok('decisions:revoke', { id: first.id, confirmed: true });
    expect((await app.call('decisions:create', { ...base, topic: 'Dach' })).ok).toBe(true);
    expect(await app.ok('decisions:list', {})).toHaveLength(3);
  });
  it('the same text in another project is another decision, also when neither has a topic', async () => {
    const base = {
      decisionText: 'Wir verschieben den Start um einen Monat.',
      decidedAt: '2026-09-01',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    };
    const apollo = await app.ok('decisions:create', { ...base, project: 'Apollo' });
    const phoenix = await app.ok('decisions:create', { ...base, project: 'Phoenix' });
    expect(phoenix.id).not.toBe(apollo.id);
    expect(phoenix.projectName).toBe('Phoenix');

    const duplicate = await app.call('decisions:create', { ...base, project: 'apollo' });
    expect(duplicate.ok).toBe(false);

    const recorded = app.services.actions.propose({
      actionType: 'record_decision',
      label: 'Entscheidung erfassen',
      rationale: 'Test',
      confidence: 0.7,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { title: 'Start verschieben', decisionText: base.decisionText, project: 'Nova' },
    });
    expect((await approve(recorded.id)).status).toBe('executed');
    const decisions = await app.ok('decisions:list', {});
    expect(decisions.map((d) => d.projectName).toSorted()).toEqual(['Apollo', 'Nova', 'Phoenix']);
  });
});
