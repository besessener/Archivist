import type { RelationMethod, RelationType } from '@archivist/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const note = async (name: string) => (await app.services.notes.create({ title: name, content: `${name} – Inhalt` })).id;
const propose = (a: string, b: string, method: RelationMethod, type: RelationType = 'related_to', evidence = `Beleg ${method}`) =>
  graph().link({ sourceId: a, targetId: b, relationType: type }, { status: 'proposed', method, evidence, confidence: 0.7 })!;
const statusOf = (id: string) => graph().getRelation(id)!.status;
const lastAudit = async (action: string) => (await app.ok('audit:list', { limit: 50 })).find((a) => a.action === action)!;

describe('Link proposals reviewed in one place (#280)', () => {
  it('lists open proposals grouped by method with evidence – without field mirrors and own flows, paged with the total', async () => {
    app = await createTestApp();
    const [a, b, c, d] = [await note('A'), await note('B'), await note('C'), await note('D')];
    propose(a, b, 'similarity');
    propose(a, c, 'similarity');
    propose(c, d, 'co_origin');
    propose(b, d, 'date_person');
    // not listed: a field mirror, a contradiction (own flow), a confirmed relation
    graph().link({ sourceId: a, targetId: graph().ensureEntity({ type: 'topic', name: 'Haus' }).id, relationType: 'relates_to' }, { status: 'proposed' });
    propose(b, c, 'analysis', 'contradicts');
    graph().link({ sourceId: a, targetId: d, relationType: 'related_to' }, { status: 'confirmed', resolvedByUser: true, method: 'manual' });

    const all = await app.ok('links:proposals', { groupBy: 'method', limit: 50, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.groups).toEqual([
      { key: 'co_origin', label: 'gemeinsam entstanden', count: 1 },
      { key: 'date_person', label: 'gleicher Tag, gleiche Person', count: 1 },
      { key: 'similarity', label: 'ähnlicher Inhalt', count: 2 },
    ]);
    expect(all.items.map((i) => i.groupKey)).toEqual(['co_origin', 'date_person', 'similarity', 'similarity']);
    expect(all.items[0]).toMatchObject({ source: { id: c, name: 'C' }, target: { id: d, name: 'D' }, relation: { evidence: 'Beleg co_origin' } });

    const page2 = await app.ok('links:proposals', { groupBy: 'method', limit: 2, offset: 2 });
    expect(page2.total).toBe(4);
    expect(page2.items.map((i) => i.groupKey)).toEqual(['similarity', 'similarity']);

    const byEntry = await app.ok('links:proposals', { groupBy: 'entry', limit: 50, offset: 0 });
    expect(byEntry.groups).toEqual([
      { key: a, label: 'A', count: 2 },
      { key: b, label: 'B', count: 1 },
      { key: c, label: 'C', count: 1 },
    ]);
  });

  it('confirm and reject one by one – each decision is undoable', async () => {
    app = await createTestApp();
    const [a, b, c] = [await note('A'), await note('B'), await note('C')];
    const r1 = propose(a, b, 'similarity');
    const r2 = propose(a, c, 'similarity');
    expect(await app.ok('links:decide', { relationIds: [r1.id], decision: 'confirmed', confirmed: true })).toEqual({ decided: 1 });
    expect(await app.ok('links:decide', { relationIds: [r2.id], decision: 'rejected', confirmed: true })).toEqual({ decided: 1 });
    expect([statusOf(r1.id), statusOf(r2.id)]).toEqual(['confirmed', 'rejected']);
    expect((await app.ok('links:proposals', {})).total).toBe(0);

    expect((await app.ok('audit:undo', { auditId: (await lastAudit('relation.rejectMany')).id })).undone).toBe(true);
    expect(statusOf(r2.id)).toBe('proposed');
    expect(graph().getRelation(r2.id)!.resolvedByUser).toBe(false);
    // the knowledge page's confirm/reject is undoable as well
    await app.ok('knowledge:resolveRelation', { relationId: r2.id, status: 'rejected', confirmed: true });
    expect((await app.ok('audit:undo', { auditId: (await lastAudit('relation.reject')).id })).undone).toBe(true);
    expect(statusOf(r2.id)).toBe('proposed');
  });

  it('„Alle bestätigen“ confirms a whole group – also beyond the page – as ONE undo step', async () => {
    app = await createTestApp();
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await note(`N${i}`));
    const sim = [propose(ids[0]!, ids[1]!, 'similarity'), propose(ids[0]!, ids[2]!, 'similarity'), propose(ids[3]!, ids[4]!, 'similarity')];
    const other = propose(ids[1]!, ids[3]!, 'co_origin');

    expect(await app.ok('links:decideGroup', { groupBy: 'method', key: 'similarity', decision: 'confirmed', confirmed: true })).toEqual({ decided: 3 });
    expect(sim.map((r) => statusOf(r.id))).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(statusOf(other.id)).toBe('proposed');
    const entries = (await app.ok('audit:list', { limit: 50 })).filter((a) => a.action === 'relation.confirmMany');
    expect(entries).toHaveLength(1);

    expect((await app.ok('audit:undo', { auditId: entries[0]!.id })).undone).toBe(true);
    expect(sim.map((r) => statusOf(r.id))).toEqual(['proposed', 'proposed', 'proposed']);
  });

  it('the undo of a group refuses when one of the relations changed since', async () => {
    app = await createTestApp();
    const [a, b, c] = [await note('A'), await note('B'), await note('C')];
    const r1 = propose(a, b, 'similarity');
    propose(a, c, 'similarity');
    await app.ok('links:decideGroup', { groupBy: 'entry', key: a, decision: 'confirmed', confirmed: true });
    await app.ok('knowledge:unlink', { relationId: r1.id, confirmed: true });
    const res = await app.ok('audit:undo', { auditId: (await lastAudit('relation.confirmMany')).id });
    expect(res.undone).toBe(false);
  });

  it('notifies only about NEW proposals: one notification, renewed only after it was read', async () => {
    app = await createTestApp({ autoLinks: true });
    const flat = (what: string) => `${what} für die Wohnung in der Hauptstraße 5. Vermieter Schmidt, Kaution 1500 Euro, Miete monatlich.`;
    const linkNotes = async () => (await app.ok('notifications:list', {})).filter((n) => n.title === 'Verknüpfungsvorschläge');
    await app.ok('knowledge:createEntity', { type: 'note', name: 'Mietvertrag', description: flat('Mietvertrag') });
    await app.services.jobs.whenIdle();
    expect(await linkNotes()).toEqual([]);

    await app.ok('knowledge:createEntity', { type: 'note', name: 'Nebenkosten', description: flat('Nebenkosten') });
    await app.services.jobs.whenIdle();
    const first = await linkNotes();
    expect(first).toHaveLength(1);
    expect(first[0]!.description).toBe('Ein Vorschlag wartet auf deine Prüfung. Du entscheidest, was übernommen wird.');

    await app.ok('knowledge:createEntity', { type: 'note', name: 'Kündigung', description: flat('Kündigung') });
    await app.services.jobs.whenIdle();
    const second = await linkNotes();
    expect(second).toHaveLength(1);
    expect(second[0]!.description).toMatch(/^\d+ Vorschläge warten auf deine Prüfung/);

    // nothing new: no new notification
    await app.ok('notifications:markRead', { ids: [second[0]!.id] });
    await app.services.notes.reindex(app.services.graph.listEntities({ type: 'note' })[0]!.id);
    await app.services.jobs.whenIdle();
    expect(await linkNotes()).toHaveLength(1);

    await app.ok('knowledge:createEntity', { type: 'note', name: 'Übergabe', description: flat('Übergabe') });
    await app.services.jobs.whenIdle();
    expect(await linkNotes()).toHaveLength(2);
  });
});
