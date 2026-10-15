import { afterEach, describe, expect, it } from 'vitest';
import { agentApp, lastToolOutput, scriptedTurns } from '../helpers/agent';
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

  it('a proposal below the bar is shown nowhere: entry detail, graph, neighbours, research and the list of entries without links', async () => {
    app = await createTestApp({ autoLinks: false });
    const [a, b, c] = [await note('Alpha'), await note('Beta'), await note('Gamma')];
    const low = app.services.graph.link(
      { sourceId: a, targetId: b, relationType: 'related_to' },
      { status: 'proposed', method: 'similarity', confidence: 0.6 },
    );
    app.services.graph.link({ sourceId: a, targetId: c, relationType: 'related_to' }, { status: 'proposed', method: 'similarity', confidence: 0.9 });
    app.services.settings.update({ links: { minConfidence: 0.8 } });

    const others = (await app.ok('knowledge:getEntity', { id: a })).relations.map((relation) => relation.other.id);
    expect(others).toEqual([c]);
    const graph = await app.ok('knowledge:neighborhood', { id: a });
    expect(graph.edges.map((edge) => edge.id)).not.toContain(low!.id);
    expect(graph.nodes.map((node) => node.id)).not.toContain(b);
    expect(app.services.graph.neighbors(a).map((entity) => entity.id)).toEqual([c]);
    expect(app.services.graph.related(a).map((entry) => entry.entity.id)).toEqual([c]);
    expect(app.services.graph.proposalsOf(a).map((relation) => relation.id)).not.toContain(low!.id);
    // Beta's only link is below the bar: it counts as an entry without links
    expect(app.services.links.orphans().items.map((item) => item.id)).toEqual([b]);

    app.services.settings.update({ links: { minConfidence: 0 } });
    expect((await app.ok('knowledge:getEntity', { id: a })).relations.map((relation) => relation.other.id).sort()).toEqual([b, c].sort());
    expect(app.services.links.orphans().total).toBe(0);
  });

  it('the agent proposes no link below the bar; one the user asked for is still made', async () => {
    app = await agentApp();
    app.services.settings.update({ links: { minConfidence: 0.8 } });
    const [a, b] = [await note('Alpha'), await note('Beta')];
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_entries', args: { kind: 'note' } }] },
      { calls: [{ name: 'link', args: { a: 'K1', b: 'K2' } }] },
      { text: 'Fertig.' },
    );
    await app.ok('chat:send', { text: 'Gibt es Bezüge zwischen Alpha und Beta?' });
    expect(lastToolOutput(app)).toContain('Kein Vorschlag: Die Mindestsicherheit für Verknüpfungsvorschläge (80 %)');
    expect(app.services.graph.relationsOf(a).filter((relation) => relation.targetEntityId === b || relation.sourceEntityId === b)).toEqual([]);

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_entries', args: { kind: 'note' } }] },
      { calls: [{ name: 'link', args: { a: 'K1', b: 'K2', onUserRequest: true } }] },
      { text: 'Verknüpft.' },
    );
    await app.ok('chat:send', { text: 'Verknüpfe Alpha mit Beta' });
    expect(
      app.services.graph.relationsOf(a).some((relation) => relation.status === 'confirmed' && [relation.sourceEntityId, relation.targetEntityId].includes(b)),
    ).toBe(true);
  });

  it('the refiner asks no pair whose link would stay below the bar, and asks it once the bar is lowered', async () => {
    app = await createTestApp({ privacy: 'auto' });
    const [a, b] = [await note('Angebot Dach'), await note('Auftrag Dach')];
    app.services.graph.linkEntries({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'confirmed' });
    app.llm.on('RelationKindHint', () => ({ kind: 'results_from', direction: 'b_a', reason: 'Der Auftrag beruht auf dem Angebot.' }));
    app.services.settings.update({ links: { minConfidence: 0.7 } });

    expect(await app.services.refiner.run()).toBe(0);
    expect(app.llm.calls.filter((call) => call.schema === 'RelationKindHint')).toEqual([]);

    app.services.settings.update({ links: { minConfidence: 0.6 } });
    expect(await app.services.refiner.run()).toBe(1);
    expect(app.services.links.proposals().items.map((item) => item.relation.method)).toEqual(['refinement']);
  });

  it('the notice about waiting proposals follows the list: its count while unread, closed once nothing waits', async () => {
    app = await createTestApp({ autoLinks: true });
    const flat = (what: string) => `${what} für die Wohnung in der Hauptstraße 5. Vermieter Schmidt, Kaution 1500 Euro, Miete monatlich.`;
    for (const name of ['Mietvertrag', 'Nebenkosten', 'Kündigung']) await app.ok('knowledge:createEntity', { type: 'note', name, description: flat(name) });
    await app.services.jobs.whenIdle();
    const notices = () => app.services.notifications.list().filter((n) => n.title === 'Verknüpfungsvorschläge');
    const waiting = app.services.links.proposals().items;
    expect(waiting.length).toBeGreaterThan(1);
    expect(notices()).toHaveLength(1);

    app.services.graph.decideRelation(waiting[0]!.relation.id, { status: 'rejected' });
    const left = app.services.links.proposals().total;
    expect(notices()[0]!.description).toBe(
      `${left === 1 ? 'Ein Vorschlag wartet' : `${left} Vorschläge warten`} auf deine Prüfung. Du entscheidest, was übernommen wird.`,
    );

    // the rest falls below a raised bar: nothing waits any more, the notice closes
    app.services.settings.update({ links: { minConfidence: 1 } });
    expect(app.services.links.proposals().total).toBe(0);
    expect(notices()).toEqual([]);
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
