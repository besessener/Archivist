import type { DecisionInput } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionTools } from '../../packages/core/src/agent/tools/knowledge-decisions';
import { classification } from '../helpers/document-classifications';
import { emptyToolContext } from '../helpers/agent';
import { toolCaller, toolDepsOf } from '../helpers/agent-tools';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const OWN_NAME = 'Monika Lor-Zade';

const decisionInput = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  decisionText: 'Wir ziehen um.',
  topic: 'Umzug',
  decidedAt: '2026-05-01',
  participants: ['ich', 'Anna'],
  alternatives: [],
  unknownFields: [],
  sourceIds: [],
  confidence: 0.9,
  asDraft: false,
  ...over,
});

function expectOwnPersonParticipates(decisionId: string): void {
  const me = graph()
    .listEntities({ type: 'person' })
    .find((p) => p.isSelf)!;
  expect(me.name).toBe(OWN_NAME);
  expect(
    graph()
      .relationsOf(decisionId)
      .some((r) => r.sourceEntityId === me.id && r.relationType === 'participated_in'),
  ).toBe(true);
  expect(
    graph()
      .listEntities({ type: 'person' })
      .filter((p) => p.name.toLowerCase() === 'ich'),
  ).toEqual([]);
}

describe('„ich“ in decision participants is the own person on every path (#188)', () => {
  beforeEach(() => {
    app.services.settings.update({ profile: { name: OWN_NAME, nicknames: [] } });
  });

  it('form: decisions:create', async () => {
    const created = await app.ok('decisions:create', decisionInput());
    expect(created.participants).toEqual([OWN_NAME, 'Anna']);
    expectOwnPersonParticipates(created.id);
  });

  it('form: decisions:update', async () => {
    const created = await app.ok('decisions:create', decisionInput({ participants: ['Anna'] }));
    const updated = await app.ok('decisions:update', { id: created.id, patch: { participants: ['Anna', 'mir'] } });
    expect(updated.participants).toEqual(['Anna', OWN_NAME]);
    expectOwnPersonParticipates(created.id);
  });

  it('agent tool record_decision', async () => {
    const call = toolCaller(decisionTools(toolDepsOf(app)), { ...emptyToolContext(), trigger: 'background' });
    await call('record_decision', { text: 'Wir ziehen um', topic: 'Umzug', participants: ['ich', 'Anna'], decidedAt: '2026-05-01' });
    const [created] = await app.ok('decisions:list', {});
    expect(created!.participants).toEqual([OWN_NAME, 'Anna']);
    expectOwnPersonParticipates(created!.id);
  });

  it('agent tool amend_decision', async () => {
    const created = await app.ok('decisions:create', decisionInput({ participants: ['Anna'] }));
    const context = emptyToolContext();
    await toolCaller(decisionTools(toolDepsOf(app)), context)('amend_decision', { id: context.refs.entry(created.id), participants: ['ich'] });
    expect((await app.ok('decisions:get', { id: created.id })).participants).toEqual(['Anna', OWN_NAME]);
    expectOwnPersonParticipates(created.id);
  });

  it('a decision proposal from a document, once approved: „ich“ is the author, not the user', async () => {
    const action = app.services.actions.propose({
      actionType: 'record_decision',
      label: 'Entscheidung',
      rationale: 'x',
      confidence: 0.6,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { title: 'Umzug', decisionText: 'Wir ziehen um.', topic: 'Umzug', participants: ['ich', 'Anna'], sourceIds: ['doc'] },
    });
    await app.ok('actions:resolve', { decision: 'approve', actionId: action.id, confirmed: true, strongConfirmed: false });
    const [created] = await app.ok('decisions:list', {});
    const me = graph()
      .listEntities({ type: 'person' })
      .find((p) => p.isSelf);
    expect(created!.participants).not.toContain(OWN_NAME);
    expect(created!.participants).toContain('Anna');
    expect(me).toBeUndefined();
  });

  it('a form decision citing a document source does not map „ich“ either, a patch adding one neither', async () => {
    const created = await app.ok('decisions:create', decisionInput({ sourceIds: ['doc'] }));
    expect(created.participants).not.toContain(OWN_NAME);
    const plain = await app.ok('decisions:create', decisionInput({ decisionText: 'Wir kaufen.', participants: ['Anna'] }));
    const patched = await app.ok('decisions:update', { id: plain.id, patch: { participants: ['Anna', 'ich'], sourceIds: ['doc'] } });
    expect(patched.participants).not.toContain(OWN_NAME);
  });

  it('stays the author, not the user, in a document’s person list', () => {
    expect(app.services.persons.resolveNames(['ich'], { context: 'document' }).entities).toEqual([]);
  });
});

describe('every creation path resolves topics, projects and tags by alias (#188)', () => {
  const topic = () => {
    const entity = graph().ensureEntity({ type: 'topic', name: 'Hauskauf' });
    graph().addAlias(entity.id, 'Immobilienerwerb');
    return entity;
  };
  const project = () => {
    const entity = graph().ensureEntity({ type: 'project', name: 'Umzug 2026' });
    graph().addAlias(entity.id, 'Der Umzug');
    return entity;
  };
  const counts = () => ({ topics: graph().listEntities({ type: 'topic' }).length, projects: graph().listEntities({ type: 'project' }).length });

  it('open items, create and update', async () => {
    const [knownTopic, knownProject] = [topic(), project()];
    const item = await app.ok('openItems:create', { title: 'Vertrag prüfen', topic: 'Immobilienerwerb', priority: 'normal', sourceIds: [], confidence: 0.9 });
    expect(item.topicId).toBe(knownTopic.id);
    const updated = await app.ok('openItems:update', { id: item.id, patch: { project: 'der umzug' } });
    expect(updated.projectId).toBe(knownProject.id);
    expect(counts()).toEqual({ topics: 1, projects: 1 });
  });

  it('events, create and update', async () => {
    const [knownTopic, knownProject] = [topic(), project()];
    const event = await app.ok('events:create', { title: 'Besichtigung', occurredAt: '2026-05-02', topic: 'Immobilienerwerb', sourceIds: [] });
    expect(event.topicId).toBe(knownTopic.id);
    const updated = await app.ok('events:update', { id: event.id, patch: { project: 'Der Umzug' } });
    expect(updated.projectId).toBe(knownProject.id);
    expect(counts()).toEqual({ topics: 1, projects: 1 });
  });

  it('decisions, update', async () => {
    const [knownTopic, knownProject] = [topic(), project()];
    const created = await app.ok('decisions:create', decisionInput({ topic: undefined, participants: [] }));
    const updated = await app.ok('decisions:update', { id: created.id, patch: { topic: 'Immobilienerwerb', project: 'Der Umzug' } });
    expect([updated.topicId, updated.projectId]).toEqual([knownTopic.id, knownProject.id]);
    expect(counts()).toEqual({ topics: 1, projects: 1 });
  });

  it('chat notes use the topic behind an alias', async () => {
    const knownTopic = topic();
    app.llm.on('ChatIntent', () => ({ intent: 'note_capture', confidence: 0.9, rationale: 't', topic: 'Immobilienerwerb', note: 'Notar anrufen' }));
    await app.ok('chat:send', { text: 'Notiz zum Immobilienerwerb: Notar anrufen' });
    expect(counts().topics).toBe(1);
    expect(
      graph()
        .neighbors(knownTopic.id)
        .some((n) => n.type === 'note'),
    ).toBe(true);
  });

  it('documents: metadata update with topic, project and tag', async () => {
    const [knownTopic, knownProject] = [topic(), project()];
    const tag = graph().ensureEntity({ type: 'tag', name: 'Wichtig' });
    graph().addAlias(tag.id, 'Dringlich');
    app.llm.on('DocumentClassification', () => classification({ title: 'Kaufvertrag', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes' }));
    const imported = await app.ok('documents:import', { paths: [app.file('in/kaufvertrag.txt', 'Kaufvertrag: ausreichend langer Inhalt für den Test')] });
    await app.services.jobs.whenIdle();
    const id = imported.imported[0]!.id;

    const updated = await app.ok('documents:updateMetadata', {
      id,
      topic: 'Immobilienerwerb',
      project: 'Der Umzug',
      tags: ['Dringlich'],
      confirmed: true,
    } as never);

    expect([updated.topicId, updated.projectId]).toEqual([knownTopic.id, knownProject.id]);
    expect(graph().listEntities({ type: 'tag' })).toHaveLength(1);
    expect(counts()).toEqual({ topics: 1, projects: 1 });
  });

  it('knowledge page „Neu anlegen“ and the agent tool create_subject reuse the entry', async () => {
    const knownTopic = topic();
    const viaPage = await app.ok('knowledge:createEntity', { type: 'topic', name: 'Immobilienerwerb' });
    expect(viaPage).toMatchObject({ created: false, entity: { id: knownTopic.id } });
    expect(counts().topics).toBe(1);
  });

  it('read-side lookups find the entry behind an alias, too', async () => {
    const knownTopic = topic();
    expect(graph().findByNameOrAlias('topic', 'immobilienerwerb')?.id).toBe(knownTopic.id);
    app.llm.on('ChatIntent', () => ({ intent: 'timeline_query', confidence: 0.9, rationale: 't', topic: 'Immobilienerwerb' }));
    await app.ok('decisions:create', decisionInput({ topic: 'Hauskauf', participants: [] }));
    const reply = await app.ok('chat:send', { text: 'Zeig mir die Zeitleiste zum Immobilienerwerb' });
    expect(reply.assistantMessage.content).toContain('Hauskauf');
  });
});

describe('a name given as topic and as project is one project (#188)', () => {
  const entriesNamed = (name: string) =>
    graph()
      .listEntities({ limit: 1000 })
      .filter((e) => (e.type === 'topic' || e.type === 'project') && e.name === name)
      .map((e) => e.type);

  it('form: decisions:create with the same name in both fields keeps only the project', async () => {
    const created = await app.ok('decisions:create', decisionInput({ topic: 'prod-plat', project: 'prod-plat', participants: [] }));
    expect(entriesNamed('prod-plat')).toEqual(['project']);
    expect(created.projectName).toBe('prod-plat');
  });

  it('form: decisions:update points the decision at the project; the archive check asks about the older topic', async () => {
    const created = await app.ok('decisions:create', decisionInput({ topic: 'prod-plat', participants: [] }));
    expect(entriesNamed('prod-plat')).toEqual(['topic']);
    const updated = await app.ok('decisions:update', { id: created.id, patch: { project: 'prod-plat' } });
    expect(updated.topicId).toBeNull();
    expect(updated.projectName).toBe('prod-plat');

    await app.services.consistency.run({ trigger: 'manual' });
    const questions = (await app.ok('insights:list', {})).filter((insight) => insight.kind === 'topic_project_name');
    expect(questions).toHaveLength(1);
  });
});
