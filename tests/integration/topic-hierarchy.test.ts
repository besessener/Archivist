import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const topic = async (name: string) => (await app.ok('knowledge:createEntity', { type: 'topic', name })).entity;

describe('Topic hierarchy: subtopics instead of merging (#282)', () => {
  it('the duplicate question offers „Unterthema“; choosing it links the two, both stay, undo works', async () => {
    app = await createTestApp({ configured: false });
    const urlaub = await topic('Urlaub');
    const u26 = await topic('Urlaub 2026');
    await app.services.consistency.run({ trigger: 'test' });
    const q = app.services.insights.list('open').find((i) => i.kind === 'similar_entities')!;
    await app.ok('insights:respond', { response: 'choose', id: q.id, choiceId: 'subtopic', confirmed: true });

    expect(await app.ok('knowledge:hierarchy', {})).toEqual([{ childId: u26.id, parentId: urlaub.id }]);
    expect(app.services.graph.getEntity(u26.id)).toBeDefined();
    // no new duplicate question for a pair already ordered
    await app.services.consistency.run({ trigger: 'test' });
    expect(app.services.insights.list('open').filter((i) => i.kind === 'similar_entities')).toEqual([]);

    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'relation.link')!;
    await app.ok('audit:undo', { auditId: entry.id });
    expect(await app.ok('knowledge:hierarchy', {})).toEqual([]);
  });

  it('filters and the timeline on the parent include the subtopics; no cycles; only topics and projects', async () => {
    app = await createTestApp({ configured: false });
    const urlaub = await topic('Urlaub');
    const u26 = await topic('Urlaub 2026');
    const italien = await topic('Italien 2026');
    await app.ok('knowledge:link', { sourceId: u26.id, targetId: urlaub.id, relationType: 'subtopic_of', confirmed: true });
    await app.ok('knowledge:link', { sourceId: italien.id, targetId: u26.id, relationType: 'subtopic_of', confirmed: true });

    const item = await app.ok('openItems:create', { title: 'Hotel buchen', topic: 'Italien 2026' });
    const d = await app.ok('decisions:create', { decisionText: 'Wir fahren im Juli.', topic: 'Urlaub 2026', asDraft: false, sourceIds: [] });
    const ev = await app.ok('events:create', { title: 'Abflug', occurredAt: '2026-07-01T08:00:00.000Z', topic: 'Italien 2026' });

    expect((await app.ok('openItems:list', { topicId: urlaub.id })).map((i) => i.id)).toEqual([item.id]);
    expect((await app.ok('decisions:list', { topicId: urlaub.id })).map((x) => x.id)).toEqual([d.id]);
    expect((await app.ok('events:list', { topicId: urlaub.id })).map((x) => x.id)).toEqual([ev.id]);
    expect((await app.ok('timeline:get', { topicId: urlaub.id })).length).toBeGreaterThanOrEqual(3);
    // the subtopic alone does not list its parent's entries
    expect((await app.ok('decisions:list', { topicId: italien.id })).map((x) => x.id)).toEqual([]);

    const cycle = await app.call('knowledge:link', { sourceId: urlaub.id, targetId: italien.id, relationType: 'subtopic_of', confirmed: true });
    expect(cycle.ok).toBe(false);
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Packliste', description: 'Sonnencreme' })).entity;
    expect((await app.call('knowledge:link', { sourceId: note.id, targetId: urlaub.id, relationType: 'subtopic_of', confirmed: true })).ok).toBe(false);
  });

  it('knowledge questions on the parent take sources of the subtopics first', async () => {
    app = await createTestApp({ configured: false });
    const urlaub = await topic('Urlaub');
    const u26 = await topic('Urlaub 2026');
    await app.ok('knowledge:link', { sourceId: u26.id, targetId: urlaub.id, relationType: 'subtopic_of', confirmed: true });
    await app.ok('decisions:create', { decisionText: 'Unterkunft: Ferienhaus am See.', topic: 'Urlaub 2026', asDraft: false, sourceIds: [] });
    const answer = await app.services.answers.knowledgeQuestion({
      text: 'Welche Unterkunft haben wir?',
      intent: {
        intent: 'knowledge_question',
        confidence: 0.9,
        rationale: 'test',
        segment: 'Welche Unterkunft haben wir?',
        query: 'Unterkunft',
        alternativeQueries: null,
        topic: 'Urlaub',
        project: null,
        timeRange: null,
        decision: null,
        openItem: null,
        event: null,
        reminder: null,
        proposalId: null,
        path: null,
        note: null,
        decisionCertainty: null,
      },
      state: {},
    });
    expect(answer.content).toContain('Ferienhaus');
  });
});
