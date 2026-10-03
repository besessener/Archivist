import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const note = async (name: string) => (await app.services.notes.create({ title: name, content: `${name} – Inhalt` })).id;
const assign = (entry: string, hub: string) => graph().link({ sourceId: entry, targetId: hub, relationType: 'relates_to' }, { status: 'confirmed' });

describe('Related entries – direct and over shared nodes, strongest first (#276)', () => {
  it('ranks by kind and number of shared nodes and names the reason; rejected pairs and the own person do not count', async () => {
    const [a, b, c, d, e, f] = [await note('A'), await note('B'), await note('C'), await note('D'), await note('E'), await note('F')];
    const project = graph().ensureEntity({ type: 'project', name: 'Hausbau' }).id;
    const anna = graph().ensureEntity({ type: 'person', name: 'Anna' }).id;
    const tag = graph().ensureEntity({ type: 'tag', name: 'kredit' }).id;
    app.services.self.ensure();
    const me = app.services.self.get()!.id;
    for (const x of [a, b, e]) assign(x, project);
    for (const x of [a, b, c]) assign(x, anna);
    for (const x of [a, c, d]) assign(x, tag);
    for (const x of [a, f]) assign(x, me);
    graph().link(
      { sourceId: a, targetId: d, relationType: 'related_to' },
      { status: 'proposed', method: 'similarity', evidence: 'gleiche Stelle', confidence: 0.7 },
    );
    // the user said A and E do not belong together
    const r = graph().link({ sourceId: a, targetId: e, relationType: 'related_to' }, { status: 'proposed', method: 'similarity' })!;
    graph().decideRelation(r.id, { status: 'rejected' });

    const res = await app.ok('knowledge:related', { id: a });
    expect(res.total).toBe(3);
    expect(res.items.map((i) => [i.entity.name, i.reason])).toEqual([
      ['D', 'verwandt mit (vorgeschlagen, automatisch, ähnlicher Inhalt) – „gleiche Stelle“ + gleicher Tag „kredit“'],
      ['B', 'gleiches Projekt „Hausbau“ + gleiche Person „Anna“'],
      ['C', 'gleiche Person „Anna“ + gleicher Tag „kredit“'],
    ]);
    expect(res.items[0]!.relation).toMatchObject({ status: 'proposed', method: 'similarity' });
    expect(res.items[1]!.relation).toBeNull();
    expect(res.items[1]!.shared.map((s) => s.name)).toEqual(['Hausbau', 'Anna']);
  });

  it('pages with the total', async () => {
    const a = await note('A');
    const topic = graph().ensureEntity({ type: 'topic', name: 'Haus' }).id;
    assign(a, topic);
    for (let i = 0; i < 12; i += 1) assign(await note(`N${String(i).padStart(2, '0')}`), topic);
    const p1 = await app.ok('knowledge:related', { id: a, limit: 5, offset: 0 });
    const p3 = await app.ok('knowledge:related', { id: a, limit: 5, offset: 10 });
    expect(p1.total).toBe(12);
    expect(p1.items.map((i) => i.entity.name)).toEqual(['N00', 'N01', 'N02', 'N03', 'N04']);
    expect(p3.items.map((i) => i.entity.name)).toEqual(['N10', 'N11']);
  });

  it('a proposal shown there is confirmed in place and undoable', async () => {
    const [a, b] = [await note('A'), await note('B')];
    const r = graph().link({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'proposed', method: 'co_origin' })!;
    await app.ok('knowledge:resolveRelation', { relationId: r.id, status: 'confirmed', confirmed: true });
    const [item] = (await app.ok('knowledge:related', { id: a })).items;
    expect(item!.relation).toMatchObject({ status: 'confirmed', resolvedByUser: true });
    expect(item!.reason).toContain('von dir bestätigt');
  });
});

describe('Linking by hand (#277)', () => {
  it('a manual link is confirmed at once, logged, undoable and removable', async () => {
    const [a, b] = [await note('Mietvertrag'), await note('Kündigung')];
    const rel = await app.ok('knowledge:link', { sourceId: a, targetId: b, relationType: 'supersedes', confirmed: true });
    expect(rel).toMatchObject({ status: 'confirmed', origin: 'user', method: 'manual', relationType: 'supersedes' });
    const audit = (await app.ok('audit:list', { limit: 10 })).find((x) => x.action === 'relation.link')!;
    expect((await app.ok('audit:undo', { auditId: audit.id })).undone).toBe(true);
    expect(graph().getRelation(rel.id)).toBeUndefined();

    const again = await app.ok('knowledge:link', { sourceId: a, targetId: b, relationType: 'related_to', confirmed: true });
    await app.ok('knowledge:unlink', { relationId: again.id, confirmed: true });
    expect(graph().getRelation(again.id)).toBeUndefined();
  });

  it('rejects unknown relation types', async () => {
    const [a, b] = [await note('A'), await note('B')];
    const r = await app.call('knowledge:link', { sourceId: a, targetId: b, relationType: 'kennt', confirmed: true });
    expect(r.ok).toBe(false);
  });
});
