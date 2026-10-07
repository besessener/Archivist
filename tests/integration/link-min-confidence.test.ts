import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const note = async (name: string) => (await app.ok('knowledge:createEntity', { type: 'note', name, description: name })).entity.id;

describe('Minimum confidence for link proposals', () => {
  it('hides proposals below the bar in the list, the count and the related entries – and shows them again when lowered', async () => {
    app = await createTestApp({ autoLinks: false });
    const [a, b, c] = [await note('Alpha'), await note('Beta'), await note('Gamma')];
    app.services.graph.link({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'proposed', method: 'similarity', confidence: 0.6 });
    app.services.graph.link({ sourceId: a, targetId: c, relationType: 'related_to' }, { status: 'proposed', method: 'similarity', confidence: 0.9 });
    expect(app.services.links.proposals().total).toBe(2);

    app.services.settings.update({ links: { minConfidence: 0.8 } });
    const page = app.services.links.proposals();
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.relation.confidence)).toEqual([0.9]);
    expect(app.services.links.related(a).items.map((item) => item.entity.id)).toEqual([c]);

    expect(app.services.links.decideGroup({ groupBy: 'method', key: 'similarity' }, { status: 'rejected' })).toBe(1);
    app.services.settings.update({ links: { minConfidence: 0 } });
    expect(app.services.links.proposals().items.map((item) => item.relation.confidence)).toEqual([0.6]);
  });
});
