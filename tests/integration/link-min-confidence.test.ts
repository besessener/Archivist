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

  it('no method creates a proposal below the bar: same day and person, note analysis; the per-method open count hides them too', async () => {
    app = await createTestApp({ privacy: 'confirm', autoLinks: true });
    app.services.settings.update({ links: { minConfidence: 0.85 } });
    const event = (title: string) => app.services.eventRecords.create({ title, occurredAt: '2026-09-01', participants: ['Anna Berger'], sourceIds: [] }).id;
    const [first] = [event('Baubesprechung'), event('Rohbauabnahme')];
    expect(await app.ok('links:scan', { id: first })).toMatchObject({ proposed: 0 });

    // the local analysis proposes with 0.6: neither the proposal nor the tag it would point to is created
    await app.services.notes.create({ title: 'Steuer', content: 'Belege sammeln #steuer' });
    await app.services.jobs.whenIdle();
    const stored = (method: string) =>
      (app.services.database.sqlite.prepare('SELECT count(*) AS c FROM relations WHERE method = ?').get(method) as { c: number }).c;
    expect(stored('date_person')).toBe(0);
    expect(stored('analysis')).toBe(0);
    expect(app.services.graph.listEntities({ type: 'tag', limit: 10 })).toEqual([]);

    const [a, b] = [await note('Alpha'), await note('Beta')];
    app.services.graph.link({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'proposed', method: 'date_person', confidence: 0.6 });
    expect(app.services.links.metrics().methods.find((method) => method.method === 'date_person')?.open).toBe(0);
  });

  it('a note is not sent to the language model when even its analysis would stay below the bar', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    app.llm.on('NoteAnalysis', () => ({ topic: 'Steuer', project: null, persons: [], tags: [] }));
    app.services.settings.update({ links: { minConfidence: 0.75 } });
    await app.services.notes.create({ title: 'Steuer', content: 'Belege sammeln' });
    await app.services.jobs.whenIdle();
    expect(app.llm.calls.filter((call) => call.schema === 'NoteAnalysis')).toEqual([]);
  });
});
