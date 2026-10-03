import { relationProvenance } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const note = async (name: string, content = `${name} – Inhalt`) => (await app.services.notes.create({ title: name, content })).id;
const relationRows = () =>
  app.services.database.sqlite.prepare('SELECT source_entity_id AS s, target_entity_id AS t, relation_type AS type, status FROM relations').all() as Array<{
    s: string;
    t: string;
    type: string;
    status: string;
  }>;

describe('Origin, method and evidence of every relation (#270)', () => {
  it('a field mirror is „automatisch“ with method field – never „von dir bestätigt“ (#189)', async () => {
    const n = await note('Heizung');
    const topic = graph().ensureEntity({ type: 'topic', name: 'Haus' });
    const r = graph().link({ sourceId: n, targetId: topic.id, relationType: 'relates_to' }, { status: 'confirmed', confidence: 0.9 })!;
    expect(r).toMatchObject({ method: 'field', origin: 'system', resolvedByUser: false, status: 'confirmed' });
    expect(relationProvenance(r)).toBe('auto');
    // the user confirms it explicitly: now it is theirs
    graph().decideRelation(r.id, { status: 'confirmed' });
    expect(relationProvenance(graph().getRelation(r.id)!)).toBe('user_confirmed');
  });

  it('a link the user makes is „manuell“; taking over a proposal keeps its method and evidence', async () => {
    const a = await note('Mietvertrag');
    const b = await note('Kündigung');
    const c = await note('Nebenkosten');
    const manual = await app.ok('knowledge:link', { sourceId: a, targetId: b, relationType: 'related_to', confirmed: true });
    expect(manual).toMatchObject({ method: 'manual', origin: 'user', status: 'confirmed' });
    expect(relationProvenance(manual)).toBe('manual');

    const taken = await app.ok('knowledge:link', {
      sourceId: a,
      targetId: c,
      relationType: 'related_to',
      method: 'similarity',
      evidence: 'Wohnung in der Hauptstraße 5',
      confirmed: true,
    });
    expect(taken).toMatchObject({ method: 'similarity', evidence: 'Wohnung in der Hauptstraße 5', resolvedByUser: true });
    expect(relationProvenance(taken)).toBe('user_confirmed');
    const detail = await app.ok('knowledge:getEntity', { id: a });
    expect(detail.relations.find((r) => r.other.id === c)).toMatchObject({ method: 'similarity', evidence: 'Wohnung in der Hauptstraße 5' });
  });

  it('a proposal keeps the evidence of its first finding; long evidence is shortened', async () => {
    const a = await note('A');
    const b = await note('B');
    const first = graph().link(
      { sourceId: a, targetId: b, relationType: 'related_to' },
      { method: 'similarity', evidence: `Erste Stelle ${'x'.repeat(400)}` },
    )!;
    expect(first.evidence!.length).toBeLessThanOrEqual(300);
    expect(first.evidence!.endsWith('…')).toBe(true);
    const again = graph().link({ sourceId: a, targetId: b, relationType: 'related_to' }, { method: 'co_origin', evidence: 'Zweite Stelle' })!;
    expect(again).toMatchObject({ created: false, method: 'similarity' });
    expect(again.evidence).toMatch(/^Erste Stelle/);
  });

  it('a rejected pair is proposed by no method again – either direction, any type', async () => {
    const a = await note('Rechnung');
    const b = await note('Angebot');
    const r = graph().link({ sourceId: a, targetId: b, relationType: 'supports' }, { status: 'proposed', method: 'analysis' })!;
    graph().decideRelation(r.id, { status: 'rejected' });
    const before = relationRows().length;

    for (const [s, t] of [
      [a, b],
      [b, a],
    ] as const) {
      const again = graph().link({ sourceId: s, targetId: t, relationType: 'related_to' }, { status: 'proposed', method: 'similarity', evidence: 'ähnlich' })!;
      expect(again).toMatchObject({ created: false, status: 'rejected' });
    }
    expect(relationRows()).toHaveLength(before);
    // the user may still link them on purpose
    expect(
      graph().link({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'confirmed', resolvedByUser: true, method: 'manual' })!.created,
    ).toBe(true);
  });

  it('a rejection survives merging a duplicate record into the kept one', async () => {
    const keep = await note('Vertrag', 'Vertrag mit Firma X');
    const dup = await note('Vertrag (Kopie)', 'Vertrag mit Firma X');
    const other = await note('Werbung');
    const r = graph().link({ sourceId: dup, targetId: other, relationType: 'related_to' }, { status: 'proposed', method: 'similarity' })!;
    graph().decideRelation(r.id, { status: 'rejected' });
    // the duplicate is discarded in favour of the kept note (as the duplicate check does)
    app.services.database.sqlite.prepare('UPDATE entities SET duplicate_of_id = ? WHERE id = ?').run(keep, dup);

    expect(graph().rejectedBetween({ a: keep, b: other })).toBeDefined();
    expect(graph().link({ sourceId: other, targetId: keep, relationType: 'related_to' }, { status: 'proposed', method: 'similarity' })).toMatchObject({
      created: false,
      status: 'rejected',
    });
  });

  it('a rejected „Duplikat“ only means „different“ and does not block other proposals', async () => {
    const a = await note('Protokoll März');
    const b = await note('Protokoll April');
    const r = graph().link({ sourceId: a, targetId: b, relationType: 'duplicate_of' }, { status: 'proposed' })!;
    graph().decideRelation(r.id, { status: 'rejected' });
    expect(graph().rejectedBetween({ a, b })).toBeUndefined();
    expect(graph().link({ sourceId: a, targetId: b, relationType: 'related_to' }, { status: 'proposed', method: 'similarity' })).toMatchObject({
      created: true,
      status: 'proposed',
    });
  });

  it('the related entries name who stands behind a relation and its evidence', async () => {
    const a = await note('Urlaub');
    const b = await note('Flug');
    graph().link(
      { sourceId: a, targetId: b, relationType: 'related_to' },
      { status: 'proposed', method: 'co_origin', evidence: 'Wir fliegen am 3. Mai nach Rom.' },
    );
    const [rel] = (await app.ok('knowledge:related', { id: a })).items;
    expect(rel!.reason).toContain('automatisch');
    expect(rel!.reason).toContain('gemeinsam entstanden');
    expect(rel!.reason).toContain('Wir fliegen am 3. Mai nach Rom.');
  });
});
