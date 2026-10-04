import fs from 'node:fs';
import path from 'node:path';
import { relationProvenance } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const relationsOf = (id: string) => graph().relationsOf(id);

// saving queues the contradiction check as a job: wait for it
const decision = async (decisionText: string, decidedAt: string, extra: Record<string, unknown> = {}) => {
  const saved = await app.ok('decisions:create', {
    title: decisionText.slice(0, 40),
    decisionText,
    topic: 'prod-plat',
    decidedAt,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
    ...extra,
  });
  await app.services.jobs.whenIdle();
  return saved;
};

describe('topics and projects resolve via aliases (#188)', () => {
  it('naming an alias uses the existing topic or project instead of creating a new one', async () => {
    const topic = graph().ensureEntity({ type: 'topic', name: 'Hauskauf' });
    graph().addAlias(topic.id, 'Immobilienerwerb');
    const project = graph().ensureEntity({ type: 'project', name: 'Umzug 2026' });
    graph().addAlias(project.id, 'Der Umzug');

    const created = await decision('Wir kaufen das Haus.', '2026-05-01', { topic: 'immobilienerwerb', project: 'Der Umzug' });

    expect(created).toMatchObject({ topicId: topic.id, topicName: 'Hauskauf', projectId: project.id });
    expect(graph().listEntities({ type: 'topic' })).toHaveLength(1);
    expect(graph().listEntities({ type: 'project' })).toHaveLength(1);
  });

  it('an alias shared by two entries stays ambiguous and creates a new one', () => {
    const a = graph().ensureEntity({ type: 'tag', name: 'Reise' });
    const b = graph().ensureEntity({ type: 'tag', name: 'Urlaub' });
    graph().addAlias(a.id, 'Ferien');
    graph().addAlias(b.id, 'Ferien');
    const created = graph().ensureEntity({ type: 'tag', name: 'Ferien' });
    expect([a.id, b.id]).not.toContain(created.id);
  });

  it('„ich“ in a chat decision is the own person, not a text participant', () => {
    app.services.settings.update({ profile: { name: 'Monika Lor-Zade', nicknames: [] } });
    const created = app.services.decisions.create(
      {
        decisionText: 'Wir ziehen um.',
        decidedAt: '2026-05-01',
        topic: 'Umzug',
        participants: ['ich', 'Anna'],
        alternatives: [],
        unknownFields: [],
        sourceIds: [],
        confidence: 0.9,
        asDraft: false,
      },
      { actor: 'user', trigger: 'chat' },
    );
    expect(created.participants).toEqual(['Monika Lor-Zade', 'Anna']);
    const me = graph()
      .listEntities({ type: 'person' })
      .find((p) => p.name === 'Monika Lor-Zade')!;
    expect(relationsOf(me.id).some((r) => r.relationType === 'participated_in')).toBe(true);
  });
});

describe('merge proposals for every mergeable kind (#188)', () => {
  it.each(['topic', 'project', 'person', 'tag'] as const)('proposes merging two %s entries and merges them after confirmation', async (type) => {
    const source = graph().ensureEntity({ type, name: 'Quelle Eins' });
    const target = graph().ensureEntity({ type, name: 'Ziel Zwei' });

    const action = await app.ok('knowledge:proposeMerge', { sourceId: source.id, targetId: target.id });
    expect(action.actionType).toBe('merge_entities');
    expect(graph().getEntity(source.id)).toBeDefined();

    await app.ok('actions:resolve', { decision: 'approve', actionId: action.id, confirmed: true } as never);
    expect(graph().getEntity(source.id)).toBeUndefined();
    expect(graph().getEntity(target.id)!.aliases).toContain('Quelle Eins');
  });

  it('refuses different kinds, the same entry and kinds that cannot be merged', async () => {
    const topic = graph().ensureEntity({ type: 'topic', name: 'Eins' });
    const project = graph().ensureEntity({ type: 'project', name: 'Zwei' });
    const caseA = graph().ensureEntity({ type: 'case', name: 'Vorgang A' });
    const caseB = graph().ensureEntity({ type: 'case', name: 'Vorgang B' });
    await expect(app.call('knowledge:proposeMerge', { sourceId: topic.id, targetId: project.id })).resolves.toMatchObject({ ok: false });
    await expect(app.call('knowledge:proposeMerge', { sourceId: topic.id, targetId: topic.id })).resolves.toMatchObject({ ok: false });
    await expect(app.call('knowledge:proposeMerge', { sourceId: caseA.id, targetId: caseB.id })).resolves.toMatchObject({ ok: false });
  });
});

async function archivedWithPerson(title: string, person: string): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title, summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes', persons: [person] }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${title}.txt`, `${title}: ausreichend langer Inhalt für den Test`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'index_only' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

describe('relation semantics (#189)', () => {
  it('a person named in a document is „erwähnt in“, confirmed from the text and „automatisch“ – never „hat erzeugt“', async () => {
    const id = await archivedWithPerson('Mietvertrag', 'Anna Albers');
    const anna = graph().findByName('person', 'Anna Albers')!;
    const mention = relationsOf(anna.id).find((r) => r.targetEntityId === id)!;
    expect(mention).toMatchObject({ relationType: 'mentioned_in', status: 'confirmed', method: 'mention', resolvedByUser: false });
    expect(relationProvenance(mention)).toBe('auto');
    expect(relationsOf(anna.id).some((r) => r.relationType === 'produced')).toBe(false);
  });

  it('the low-confidence review also covers relations at exactly 0.5', async () => {
    const a = graph().ensureEntity({ type: 'topic', name: 'Alpha' });
    const b = graph().ensureEntity({ type: 'topic', name: 'Beta' });
    graph().link({ sourceId: a.id, targetId: b.id, relationType: 'related_to' }, { confidence: 0.5, status: 'proposed' });
    await app.services.consistency.run({ trigger: 'test' });
    expect(app.services.insights.list({ status: 'open' }).some((insight) => insight.kind === 'low_confidence_relation')).toBe(true);
  });

  it('a decision field mirror is shown as automatic until the user decides on it', async () => {
    const created = await decision('Wir bleiben bei prod-plat.', '2026-01-10');
    const topic = graph().findByName('topic', 'prod-plat')!;
    const mirror = relationsOf(created.id).find((r) => r.targetEntityId === topic.id)!;
    expect(mirror).toMatchObject({ status: 'confirmed', resolvedByUser: false });
    expect(relationProvenance(mirror)).toBe('auto');
    graph().decideRelation(mirror.id, { status: 'confirmed' });
    expect(relationProvenance(graph().getRelation(mirror.id)!)).toBe('user_confirmed');
  });

  it.each([
    ['resolved', 'outdated'],
    ['false_positive', 'rejected'],
  ] as const)('closing a contradiction as %s leaves its „widerspricht“ relation %s', async (resolution, expected) => {
    app.llm.down = true;
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [contradiction] = await app.ok('contradictions:list', {});
    const contradicts = () => relationsOf(newer.id).find((r) => r.relationType === 'contradicts' && r.targetEntityId === older.id)!;
    expect(contradicts().status).toBe('proposed');

    await app.ok('contradictions:resolve', { id: contradiction!.id, resolution, confirmed: true } as never);

    expect(contradicts().status).toBe(expected);
  });

  it('the migration turns old system mention relations into „erwähnt in“ and keeps decisions of the user', () => {
    const { sqlite } = app.services.database;
    const person = graph().ensureEntity({ type: 'person', name: 'Berta Beispiel' });
    const other = graph().ensureEntity({ type: 'person', name: 'Carl Beispiel' });
    const insert = sqlite.prepare(
      `INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence, source_ids, status, resolved_by_user, origin, method, created_at, updated_at)
       VALUES (?, ?, ?, 'produced', 0.5, '[]', ?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
    );
    const document = graph().ensureEntity({ type: 'case', name: 'Platzhalter' });
    sqlite.prepare("UPDATE entities SET type = 'document' WHERE id = ?").run(document.id);
    insert.run('old-system', person.id, document.id, 'proposed', 0, null, 'field');
    insert.run('old-user', other.id, document.id, 'confirmed', 1, 'user', 'manual');
    const third = graph().ensureEntity({ type: 'person', name: 'Dora Beispiel' });
    insert.run('old-other-method', third.id, document.id, 'proposed', 0, null, 'agent');

    const migration = fs.readFileSync(path.resolve(__dirname, '../../packages/core/migrations/0026_mentions_not_produced.sql'), 'utf8');
    sqlite.exec(migration);

    const rows = sqlite
      .prepare("SELECT id, relation_type AS type, status, method FROM relations WHERE id IN ('old-system', 'old-user', 'old-other-method') ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: 'old-other-method', type: 'produced', status: 'proposed', method: 'agent' },
      { id: 'old-system', type: 'mentioned_in', status: 'confirmed', method: 'mention' },
      { id: 'old-user', type: 'produced', status: 'confirmed', method: 'manual' },
    ]);
  });
});
