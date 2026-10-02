import { afterEach, describe, expect, it } from 'vitest';
import { LinkThresholds } from '../../packages/core/src/services/link-thresholds';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app?.cleanup();
});

describe('Learning from rejections, gently (#275)', () => {
  it('the raise grows with the rejection rate, is capped and needs enough decisions', () => {
    const cap = 0.1;
    expect(LinkThresholds.raise({ confirmed: 0, rejected: 7 }, cap)).toBe(0); // too few decisions
    expect(LinkThresholds.raise({ confirmed: 10, rejected: 10 }, cap)).toBe(0); // half rejected: nothing learned yet
    expect(LinkThresholds.raise({ confirmed: 3, rejected: 17 }, cap)).toBe(0.088);
    expect(LinkThresholds.raise({ confirmed: 0, rejected: 20 }, cap)).toBe(cap);
    // capped: no number of rejections goes beyond it
    expect(LinkThresholds.raise({ confirmed: 0, rejected: 1000 }, cap)).toBe(cap);
    // few decisions only count partly
    expect(LinkThresholds.raise({ confirmed: 0, rejected: 10 }, cap)).toBe(0.05);
  });

  it('confirmations lower the threshold again; reset forgets; proposals become stricter but never stop', async () => {
    app = await createTestApp({ autoLinks: false });
    const { graph, linkThresholds } = app.services;
    const note = async (name: string) => (await app.ok('knowledge:createEntity', { type: 'note', name, description: `${name} Text` })).entity.id;
    const hub = await note('Zentrale');
    const decide = async (n: number, decision: 'confirmed' | 'rejected') => {
      for (let i = 0; i < n; i += 1) {
        const other = await note(`${decision} ${i} ${Math.random()}`);
        const r = graph.link(hub, other, 'related_to', { status: 'proposed', method: 'similarity', evidence: 'x' })!;
        graph.decideRelation(r.id, decision);
      }
    };
    const similarity = () => linkThresholds.list().find((t) => t.method === 'similarity')!;

    await decide(20, 'rejected');
    expect(similarity()).toMatchObject({ offset: 0.1, cap: 0.1, rejected: 20, confirmed: 0 });
    expect((await app.ok('links:thresholds', {})).map((t) => t.method)).toEqual(['similarity', 'date_person']);
    // other methods learn nothing from it
    expect(linkThresholds.offset('date_person')).toBe(0);

    // the latest decisions count: confirmations bring it down
    await decide(12, 'confirmed');
    expect(similarity().offset).toBeLessThan(0.1);
    await decide(10, 'confirmed');
    expect(similarity().offset).toBe(0);

    // the window holds the latest 40 decisions: 30 rejections against 10 confirmations
    await decide(30, 'rejected');
    expect(similarity()).toMatchObject({ offset: 0.063, rejected: 30, confirmed: 10 });
    await new Promise((r) => setTimeout(r, 5));
    await app.ok('links:resetThresholds', { confirmed: true });
    expect(similarity()).toMatchObject({ offset: 0, confirmed: 0, rejected: 0 });
  });

  it('a raised similarity threshold holds back weaker proposals, strong ones still come', async () => {
    app = await createTestApp({ autoLinks: false });
    const { graph, links } = app.services;
    const note = async (name: string, description: string) => (await app.ok('knowledge:createEntity', { type: 'note', name, description })).entity.id;
    const same = 'Mietvertrag Wohnung Hauptstraße 5, Vermieter Schmidt, Kaution 1500 Euro, Miete monatlich.';
    const a = await note('Mietvertrag', same);
    const twin = await note('Mietvertrag Kopie', same);
    const weak = await note('Nebenkosten', 'Nebenkosten Wohnung Hauptstraße 5, Vermieter Schmidt, Heizung und Wasser für das Jahr.');
    await app.services.jobs.whenIdle();
    const before = (await links.candidates(a, { limit: 5 })).filter((c) => c.method === 'similarity');
    const weakScore = before.find((c) => c.id === weak)?.score;
    expect(before.map((c) => c.id)).toContain(twin);

    // the user rejected the last 20 similarity proposals
    for (let i = 0; i < 20; i += 1) {
      const x = await note(`Abgelehnt ${i}`, `Etwas ganz anderes Nummer ${i}`);
      const y = await note(`Auch abgelehnt ${i}`, `Wieder etwas anderes ${i}`);
      graph.decideRelation(graph.link(x, y, 'related_to', { status: 'proposed', method: 'similarity' })!.id, 'rejected');
    }
    await app.services.jobs.whenIdle();
    const after = (await links.candidates(a, { limit: 5 })).filter((c) => c.method === 'similarity');
    expect(after.map((c) => c.id)).toContain(twin);
    if (weakScore !== undefined && weakScore < 0.6) expect(after.map((c) => c.id)).not.toContain(weak);
  });
});
