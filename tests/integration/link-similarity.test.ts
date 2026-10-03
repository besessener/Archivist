import { afterEach, describe, expect, it } from 'vitest';
import { MIN_SIMILARITY } from '../../packages/core/src/services/link-methods';
import { createTestApp, type TestApp } from '../helpers/harness';
import { archived, inInbox } from '../helpers/agent';
import { flatText } from '../helpers/link-texts';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const relatedTo = () =>
  app.services.database.sqlite
    .prepare(`SELECT source_entity_id AS s, target_entity_id AS t, status, method, origin, evidence FROM relations WHERE relation_type = 'related_to'`)
    .all() as Array<{ s: string; t: string; status: string; method: string; origin: string; evidence: string | null }>;
const between = (a: string, b: string) => relatedTo().filter((r) => (r.s === a && r.t === b) || (r.s === b && r.t === a));

describe('Similar entries as `related_to` proposals after indexing (#271)', () => {
  it('archiving proposes similar documents with the passage as evidence – in a job, not on the archiving path', async () => {
    app = await createTestApp({ autoLinks: true });
    const lease = await archived(app, { name: 'mietvertrag.md', content: flatText('Mietvertrag'), folder: 'Privat/wohnen' });
    const costs = await archived(app, { name: 'nebenkosten.md', content: flatText('Nebenkostenabrechnung'), folder: 'Privat/wohnen' });
    const recipe = await archived(app, { name: 'rezept.md', content: 'Rezept für Apfelkuchen mit Zucker, Mehl und Butter.', folder: 'Privat/kochen' });
    await app.services.jobs.whenIdle();

    expect(between(lease, costs)).toEqual([expect.objectContaining({ status: 'proposed', method: 'similarity', origin: 'system' })]);
    expect(between(lease, costs)[0]!.evidence).toContain('Hauptstraße 5');
    expect(between(lease, recipe)).toEqual([]);
    expect(between(costs, recipe)).toEqual([]);
    const jobs = (await app.ok('jobs:list', {})).filter((j) => j.type === 'links.similar');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('notes and open items are proposed as well; inbox documents are not', async () => {
    app = await createTestApp({ autoLinks: true });
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Wohnung', description: flatText('Notiz zum Mietvertrag') })).entity.id;
    const item = (await app.ok('openItems:create', { title: 'Kaution zurückfordern', description: flatText('Kaution vom Mietvertrag') })).id;
    const inbox = await inInbox(app, { name: 'mietvertrag-kopie.md', content: flatText('Mietvertrag') });
    await app.services.jobs.whenIdle();

    expect(between(note, item)).toEqual([expect.objectContaining({ status: 'proposed', method: 'similarity' })]);
    expect([...between(note, inbox), ...between(item, inbox)]).toEqual([]);
  });

  it('at most N proposals per entry; linked, rejected and duplicate pairs are skipped – also when indexed again', async () => {
    app = await createTestApp({ autoLinks: true });
    app.services.settings.update({ links: { maxProposalsPerEntry: 1 } });
    const notes: string[] = [];
    for (const what of ['Mietvertrag', 'Nebenkosten', 'Kündigung', 'Übergabe'])
      notes.push((await app.ok('knowledge:createEntity', { type: 'note', name: what, description: flatText(what) })).entity.id);
    await app.services.jobs.whenIdle();
    for (const id of notes) {
      const open = relatedTo().filter((r) => r.status === 'proposed' && (r.s === id || r.t === id));
      expect(open.length).toBeLessThanOrEqual(1);
    }
    expect(relatedTo().length).toBeGreaterThan(0);

    // the user rejects every proposal and allows more: the rejected pairs never come back
    for (const r of app.services.graph.relationsOf(notes[0]!, { statuses: ['proposed'] })) app.services.graph.decideRelation(r.id, { status: 'rejected' });
    const rejected = relatedTo().filter((r) => r.status === 'rejected');
    app.services.settings.update({ links: { maxProposalsPerEntry: 5 } });
    for (const id of notes) await app.services.notes.reindex(id);
    await app.services.jobs.whenIdle();
    for (const r of rejected) expect(between(r.s, r.t).map((x) => x.status)).toEqual(['rejected']);

    // a pair already linked as duplicate is no candidate
    const a = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Kopie A', description: flatText('Kopie') })).entity.id;
    await app.services.jobs.whenIdle();
    const b = (await app.services.notes.create({ title: 'Kopie B', content: flatText('Kopie') })).id;
    app.services.graph.link({ sourceId: b, targetId: a, relationType: 'duplicate_of' }, { status: 'proposed' });
    await app.services.notes.reindex(b);
    await app.services.jobs.whenIdle();
    expect(between(a, b)).toEqual([]);
  });

  it('switched off in the settings: nothing is proposed', async () => {
    app = await createTestApp({ autoLinks: false });
    await app.ok('knowledge:createEntity', { type: 'note', name: 'Mietvertrag', description: flatText('Mietvertrag') });
    await app.ok('knowledge:createEntity', { type: 'note', name: 'Nebenkosten', description: flatText('Nebenkosten') });
    await app.services.jobs.whenIdle();
    expect(relatedTo()).toEqual([]);
  });

  it('real embeddings have a lower bar than the lexical local vectors', async () => {
    expect(MIN_SIMILARITY.local).toBeGreaterThan(MIN_SIMILARITY.embeddings);
    app = await createTestApp({ autoLinks: true, privacy: 'auto' });
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    // three short texts: B is close to A (cosine 0.47 – above the bar of embeddings, below the local one), C is far
    const vec: Record<string, number[]> = { Alpha: [1, 0, 0], Beta: [0.47, Math.sqrt(1 - 0.47 ** 2), 0], Gamma: [0.2, 0, Math.sqrt(1 - 0.04)] };
    app.llm.embed = (texts) => texts.map((t) => vec[Object.keys(vec).find((k) => t.includes(k))!]!);
    const ids: Record<string, string> = {};
    for (const name of Object.keys(vec)) {
      const id = `note-${name}`;
      ids[name] = id;
      app.services.graph.registerNode({ type: 'note', id, name, description: `${name} Text` });
      await app.services.search.index({ type: 'note', id, title: name, content: `${name} Text`, allowRemoteEmbedding: true });
    }
    await app.services.jobs.whenIdle();
    expect(between(ids.Alpha!, ids.Beta!)).toEqual([expect.objectContaining({ status: 'proposed', method: 'similarity' })]);
    expect(between(ids.Alpha!, ids.Gamma!)).toEqual([]);
    expect(between(ids.Beta!, ids.Gamma!)).toEqual([]);
  });
});
