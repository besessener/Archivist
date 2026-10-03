import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const note = async (name: string) => (await app.ok('knowledge:createEntity', { type: 'note', name, description: name })).entity.id;

describe('Graph view of the surroundings of an entry (#288)', () => {
  it('1 or 2 steps, filtered by relation type, kind and status; rejected relations never show', async () => {
    app = await createTestApp({ configured: false });
    const g = app.services.graph;
    const a = await note('A');
    const b = await note('B');
    const c = await note('C');
    const d = await note('D');
    const project = (await app.ok('knowledge:createEntity', { type: 'project', name: 'Hausbau' })).entity.id;
    g.linkEntries({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'confirmed' });
    g.linkEntries({ sourceId: b, targetId: c, relationType: 'results_from' }, { status: 'confirmed' });
    g.link({ sourceId: a, targetId: d, relationType: 'related_to' }, { status: 'proposed', method: 'similarity' });
    g.linkEntries({ sourceId: a, targetId: project, relationType: 'belongs_to' }, { status: 'confirmed' });
    const rejected = g.link({ sourceId: a, targetId: await note('E'), relationType: 'related_to' }, { status: 'proposed', method: 'similarity' })!;
    g.decideRelation(rejected.id, { status: 'rejected' });

    const one = await app.ok('knowledge:neighborhood', { id: a });
    expect(one.centerId).toBe(a);
    expect(one.nodes.map((n) => n.name).toSorted()).toEqual(['A', 'B', 'D', 'Hausbau']);
    expect(one.edges.find((e) => e.target === d)?.status).toBe('proposed');

    const two = await app.ok('knowledge:neighborhood', { id: a, depth: 2 });
    expect(two.nodes.find((n) => n.name === 'C')).toMatchObject({ depth: 2 });

    expect((await app.ok('knowledge:neighborhood', { id: a, statuses: ['confirmed'] })).nodes.map((n) => n.name).toSorted()).toEqual(['A', 'B', 'Hausbau']);
    expect((await app.ok('knowledge:neighborhood', { id: a, entityTypes: ['project'] })).nodes.map((n) => n.name).toSorted()).toEqual(['A', 'Hausbau']);
    expect((await app.ok('knowledge:neighborhood', { id: a, depth: 2, relationTypes: ['results_from'] })).nodes.map((n) => n.name)).toEqual(['A']);
  });

  it('big hubs become one group node; the number of nodes is limited', async () => {
    app = await createTestApp({ configured: false });
    const g = app.services.graph;
    const tag = (await app.ok('knowledge:createEntity', { type: 'topic', name: 'Viel' })).entity.id;
    for (let i = 0; i < 20; i += 1) g.linkEntries({ sourceId: await note(`Notiz ${i}`), targetId: tag, relationType: 'relates_to' }, { status: 'confirmed' });
    const hub = await app.ok('knowledge:neighborhood', { id: tag });
    expect(hub.nodes).toEqual([expect.objectContaining({ id: tag, depth: 0 }), expect.objectContaining({ type: 'note', count: 20, name: '20 weitere' })]);

    const small = await app.ok('knowledge:neighborhood', { id: tag, entityTypes: ['note'], maxNodes: 5 });
    expect(small.nodes.length).toBeLessThanOrEqual(5);
  });
});
