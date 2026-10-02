import { afterEach, describe, expect, it } from 'vitest';
import { ORPHAN_INSIGHT } from '../../packages/core/src/services/link-methods';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const flatText = (what: string) => `${what} für die Wohnung in der Hauptstraße 5. Vermieter Schmidt, Kaution 1500 Euro, Miete monatlich.`;
const note = async (name: string, description: string) => (await app.ok('knowledge:createEntity', { type: 'note', name, description })).entity.id;
const hint = () => app.services.insights.byDedupeKey(ORPHAN_INSIGHT);

describe('Archive check: entries without any link (#290)', () => {
  it('proposes targets for orphans, bundles them in ONE hint and closes it once every entry has a confirmed link', async () => {
    app = await createTestApp({ autoLinks: false });
    const lease = await note('Mietvertrag', flatText('Mietvertrag'));
    const costs = await note('Nebenkosten', flatText('Nebenkostenabrechnung'));
    const recipe = await note('Apfelkuchen', 'Rezept mit Zucker, Mehl und Butter.');
    await app.services.jobs.whenIdle();
    expect(app.services.links.orphans().total).toBe(3);

    const r = await app.services.links.checkOrphans();
    expect(r).toEqual({ pending: 3, proposed: 1 });
    const proposal = app.services.graph.relationsOf(lease, { statuses: ['proposed'] });
    expect(proposal).toEqual([expect.objectContaining({ relationType: 'related_to', method: 'similarity', origin: 'system' })]);
    expect([proposal[0]!.sourceEntityId, proposal[0]!.targetEntityId].toSorted()).toEqual([lease, costs].toSorted());

    const h = hint()!;
    expect(h).toMatchObject({ kind: 'orphan_entries', status: 'open', title: '3 Einträge ohne Verknüpfung' });
    expect(h.explanation).toContain('Für 2 davon gibt es passende Ziele');
    expect(h.explanation).toContain('Einer hat noch kein passendes Ziel');
    expect(h.sourceIds.toSorted()).toEqual([lease, costs, recipe].toSorted());
    // the proposals are in the list of link proposals (#280)
    expect((await app.ok('links:proposals', {})).items.map((i) => i.relation.id)).toContain(proposal[0]!.id);

    // the user confirms the proposal: the recipe is left
    app.services.graph.decideRelation(proposal[0]!.id, 'confirmed');
    await app.services.links.checkOrphans();
    expect(hint()).toMatchObject({ title: '1 Eintrag ohne Verknüpfung', sourceIds: [recipe] });

    // the recipe gets a confirmed link: the cause is gone, the hint closes
    app.services.graph.linkEntries(recipe, lease, 'relates_to', { status: 'confirmed' });
    expect(await app.services.links.checkOrphans()).toEqual({ pending: 0, proposed: 0 });
    expect(hint()).toBeUndefined();
  });

  it('a rejected target is not proposed again; the entry counts as an orphan again', async () => {
    app = await createTestApp({ autoLinks: false });
    const lease = await note('Mietvertrag', flatText('Mietvertrag'));
    await note('Nebenkosten', flatText('Nebenkostenabrechnung'));
    await app.services.jobs.whenIdle();
    await app.services.links.checkOrphans();
    for (const rel of app.services.graph.relationsOf(lease, { statuses: ['proposed'] })) app.services.graph.decideRelation(rel.id, 'rejected');

    expect(await app.services.links.checkOrphans()).toEqual({ pending: 2, proposed: 0 });
    expect(hint()!.explanation).not.toContain('passende Ziele');
  });

  it('works through the orphans in portions and continues where the last run stopped', async () => {
    app = await createTestApp({ autoLinks: false });
    const ids: string[] = [];
    for (const [w, d] of [
      ['Zahnarzt', 'Kontrolle beim Zahnarzt im März.'],
      ['Fahrrad', 'Kette ölen und Reifen aufpumpen.'],
      ['Steuer', 'Belege für die Steuererklärung sammeln.'],
      ['Garten', 'Tomaten pflanzen nach den Eisheiligen.'],
    ] as const)
      ids.push(await note(w, d));
    await app.services.jobs.whenIdle();
    const seen = () => app.services.appState.get('links.orphans.cursor');
    const sorted = ids.toSorted();
    await app.services.links.checkOrphans({ maxEntries: 2 });
    expect(seen()).toBe(sorted[1]);
    await app.services.links.checkOrphans({ maxEntries: 2 });
    expect(seen()).toBe(sorted[3]);
    // wraps around
    await app.services.links.checkOrphans({ maxEntries: 1 });
    expect(seen()).toBe(sorted[0]);
  });

  it('runs as part of the archive check; switched off link proposals still report, but propose nothing', async () => {
    app = await createTestApp({ autoLinks: false });
    await note('Mietvertrag', flatText('Mietvertrag'));
    await note('Nebenkosten', flatText('Nebenkostenabrechnung'));
    await app.services.jobs.whenIdle();
    const report = await app.services.consistency.run('test');
    expect(report.byKind.orphan_entries).toBe(1);
    expect(report.summary).toContain('Einträge ohne Verknüpfung');
    expect(app.services.links.proposals().total).toBe(0);

    app.services.settings.update({ links: { autoPropose: true } });
    await app.services.consistency.run('test');
    expect(app.services.links.proposals().total).toBe(1);
  });
});

describe('Linkage metrics (#292)', () => {
  it('share of orphans, open proposals and the confirmation rate per method; one history point per archive check', async () => {
    app = await createTestApp({ autoLinks: false });
    const lease = await note('Mietvertrag', flatText('Mietvertrag'));
    const costs = await note('Nebenkosten', flatText('Nebenkostenabrechnung'));
    const recipe = await note('Apfelkuchen', 'Rezept mit Zucker, Mehl und Butter.');
    await app.services.jobs.whenIdle();

    let m = await app.ok('links:metrics', {});
    expect(m.current).toMatchObject({ entries: 3, orphans: 3, openProposals: 0, confirmationRate: null });
    expect(m.history).toEqual([]);

    app.services.settings.update({ links: { autoPropose: true } });
    await app.services.consistency.run('test');
    m = await app.ok('links:metrics', {});
    expect(m.current).toMatchObject({ orphans: 1, openProposals: 1 });
    expect(m.history).toHaveLength(1);
    expect(m.history[0]).toMatchObject({ entries: 3, orphans: 1, openProposals: 1 });

    // decisions of the user count per method: one confirmed, one rejected
    const [p] = app.services.graph.relationsOf(lease, { statuses: ['proposed'] });
    app.services.graph.decideRelation(p!.id, 'confirmed');
    const r = app.services.graph.link(recipe, costs, 'related_to', { status: 'proposed', method: 'mention', evidence: 'x' })!;
    app.services.graph.decideRelation(r.id, 'rejected');
    // a manual link is no proposal and does not count
    app.services.graph.linkEntries(recipe, lease, 'relates_to', { status: 'confirmed' });

    await app.services.consistency.run('test');
    m = await app.ok('links:metrics', {});
    expect(m.methods.find((x) => x.method === 'similarity')).toMatchObject({ confirmed: 1, rejected: 0, open: 0, rate: 1 });
    expect(m.methods.find((x) => x.method === 'mention')).toMatchObject({ confirmed: 0, rejected: 1, rate: 0 });
    expect(m.methods.find((x) => x.method === 'co_origin')).toMatchObject({ rate: null });
    expect(m.current).toMatchObject({ orphans: 0, openProposals: 0, confirmationRate: 0.5 });
    expect(m.history.map((h) => h.orphans)).toEqual([1, 0]);
  });
});
