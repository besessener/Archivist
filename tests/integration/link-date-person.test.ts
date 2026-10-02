import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { archived } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ autoLinks: true });
  app.services.settings.update({ profile: { name: 'Erika Muster' } });
});
afterEach(async () => {
  await app.cleanup();
});

const dayPerson = () =>
  app.services.database.sqlite
    .prepare(`SELECT source_entity_id AS s, target_entity_id AS t, status, evidence FROM relations WHERE method = 'date_person'`)
    .all() as Array<{ s: string; t: string; status: string; evidence: string }>;
const pairKey = (a: string, b: string) => [a, b].toSorted().join('|');
const pairs = () => dayPerson().map((r) => pairKey(r.s, r.t));
const event = (title: string, occurredAt: string, participants: string[]) =>
  app.services.eventRecords.create({ title, description: `${title} – Ablauf`, occurredAt, participants, sourceIds: [] });
const decision = (title: string, decidedAt: string, participants: string[]) =>
  app.services.decisions.create({
    decisionText: `${title} – beschlossen`,
    title,
    decidedAt,
    participants,
    alternatives: [],
    unknownFields: [],
    asDraft: false,
    sourceIds: [],
    confidence: 0.8,
  });

describe('Same day and same person (#278)', () => {
  it('an event and a decision of the same day with a shared person are proposed, the evidence names day and person', async () => {
    const e = event('Baubesprechung', '2026-09-01', ['Anna Berger', 'Bernd']);
    const d = decision('Fenster aus Holz', '2026-09-01', ['Anna Berger']);
    const other = decision('Dach aus Ziegeln', '2026-09-02', ['Anna Berger']);
    await app.services.jobs.whenIdle();
    expect(pairs()).toEqual([pairKey(e.id, d.id)]);
    expect(dayPerson()[0]).toMatchObject({ status: 'proposed', evidence: 'Am 01.09.2026 mit „Anna Berger“' });
    expect(pairs().some((p) => p.includes(other.id))).toBe(false);
  });

  it('the business date counts, not when it was captured; documents by their document date', async () => {
    const doc = await archived(app, 'protokoll.md', 'Protokoll der Baubesprechung.', 'private/haus', { persons: ['Anna Berger'], documentDate: '2026-08-15' });
    const e = event('Baubesprechung', '2026-08-15', ['Anna Berger']);
    // captured today, but happened on another day
    event('Telefonat', '2026-08-20', ['Anna Berger']);
    await app.services.jobs.whenIdle();
    expect(pairs()).toEqual([pairKey(doc, e.id)]);
  });

  it('the own person alone is no reason; a rejected pair is not proposed again', async () => {
    event('Arzttermin', '2026-07-01', ['Erika Muster']);
    decision('Neue Brille', '2026-07-01', ['Erika Muster']);
    await app.services.jobs.whenIdle();
    expect(dayPerson()).toEqual([]);

    const a = event('Treffen', '2026-07-02', ['Anna Berger']);
    const b = decision('Termin verschoben', '2026-07-02', ['Anna Berger']);
    await app.services.jobs.whenIdle();
    const r = app.services.graph.relationsOf(a.id).find((x) => x.method === 'date_person')!;
    app.services.graph.decideRelation(r.id, 'rejected');
    await app.ok('decisions:update', { id: b.id, patch: { title: 'Termin verschoben (neu)' } });
    await app.services.jobs.whenIdle();
    expect(dayPerson().map((x) => x.status)).toEqual(['rejected']);
  });
});
