import type { GraphRelation, RelationType } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const topicId = (name: string) => graph().ensureEntity('topic', name).id;
const projectId = (name: string) => graph().ensureEntity('project', name).id;
const personId = (name: string) => graph().ensureEntity('person', name).id;

/** The relation between two nodes with the given type (any direction), regardless of status. */
function relation(a: string, b: string, type: RelationType): GraphRelation | undefined {
  return graph()
    .relationsOf(a, { types: [type] })
    .find((r) => (r.sourceEntityId === a && r.targetEntityId === b) || (r.sourceEntityId === b && r.targetEntityId === a));
}

/** Names of the entities the knowledge page shows as connected to `id`. */
async function shownNeighbors(id: string): Promise<string[]> {
  const detail = await app.ok('knowledge:getEntity', { id });
  return detail.relations.map((r) => r.other.name).sort();
}

/** The not yet undone audit entry of `action`; `topic` picks one by the topic the edit set (timestamps may tie). */
async function latestUndoable(action: string, topic?: string) {
  const entries = await app.ok('audit:list', { limit: 50, onlyUndoable: true });
  const entry = entries.find((e) => e.action === action && !e.undoneAt && (!topic || (e.after as { topic?: string } | null)?.topic === topic));
  if (!entry) throw new Error(`no undoable ${action}`);
  return entry;
}

describe('field changes remove outdated relations', () => {
  it('decision: changing topic, project and participants outdates the old relations, undo restores them', async () => {
    const d = await app.ok('decisions:create', {
      decisionText: 'Wir nutzen Postgres.',
      decidedAt: '2026-09-01',
      topic: 'Datenbank',
      project: 'Plattform',
      participants: ['Anna', 'Ben'],
    });
    expect(await shownNeighbors(d.id)).toEqual(['Anna', 'Ben', 'Datenbank', 'Plattform']);

    await app.ok('decisions:update', {
      id: d.id,
      patch: { decisionText: 'Wir nutzen Postgres.', decidedAt: '2026-09-01', topic: 'Speicher', project: null, participants: ['Anna'] },
    });

    expect(await shownNeighbors(d.id)).toEqual(['Anna', 'Speicher']);
    expect(relation(d.id, topicId('Datenbank'), 'concerns')?.status).toBe('outdated');
    expect(relation(d.id, projectId('Plattform'), 'affects')?.status).toBe('outdated');
    expect(relation(personId('Ben'), d.id, 'participated_in')?.status).toBe('outdated');
    // the old topic no longer shows the decision and does not count it
    expect(await shownNeighbors(topicId('Datenbank'))).toEqual([]);
    const listed = await app.ok('knowledge:listEntities', { type: 'topic' });
    expect(listed.find((e) => e.name === 'Datenbank')?.relationCount).toBe(0);
    expect(
      graph()
        .neighbors(d.id, { types: ['topic', 'project', 'person'] })
        .map((e) => e.name),
    ).not.toContain('Datenbank');

    const res = await app.ok('audit:undo', { auditId: (await latestUndoable('decision.update')).id });
    expect(res.undone).toBe(true);
    const back = await app.ok('decisions:get', { id: d.id });
    expect(back.topicName).toBe('Datenbank');
    expect(back.projectName).toBe('Plattform');
    expect(back.participants).toEqual(['Anna', 'Ben']);
    expect(await shownNeighbors(d.id)).toEqual(['Anna', 'Ben', 'Datenbank', 'Plattform']);
    expect(relation(d.id, topicId('Speicher'), 'concerns')).toBeUndefined();
  });

  it('open item: user-confirmed and user-rejected relations stay untouched', async () => {
    const item = await app.ok('openItems:create', { title: 'Angebot einholen', topic: 'Dach' });
    const alt = topicId('Fassade');
    // a proposed relation to another topic that the user confirms, and one the user rejects
    const confirmed = graph().link(item.id, alt, 'relates_to', { status: 'proposed' })!;
    await app.ok('knowledge:resolveRelation', { relationId: confirmed.id, status: 'confirmed', confirmed: true });
    const rejected = graph().link(item.id, topicId('Keller'), 'relates_to', { status: 'proposed' })!;
    await app.ok('knowledge:resolveRelation', { relationId: rejected.id, status: 'rejected', confirmed: true });

    await app.ok('openItems:update', { id: item.id, patch: { title: 'Angebot einholen', topic: 'Heizung' } });

    expect(relation(item.id, topicId('Dach'), 'relates_to')?.status).toBe('outdated');
    expect(graph().getRelation(confirmed.id)?.status).toBe('confirmed');
    expect(graph().getRelation(rejected.id)?.status).toBe('rejected');
    expect(relation(item.id, topicId('Heizung'), 'relates_to')?.status).toBe('confirmed');

    // undo restores the old topic relation and removes the new one
    expect((await app.ok('audit:undo', { auditId: (await latestUndoable('open_item.update')).id })).undone).toBe(true);
    expect(relation(item.id, topicId('Dach'), 'relates_to')?.status).toBe('confirmed');
    expect(relation(item.id, topicId('Heizung'), 'relates_to')).toBeUndefined();
    expect((await app.ok('openItems:list', {})).find((i) => i.id === item.id)?.topicName).toBe('Dach');
  });

  it('event: clearing the project outdates its relation; linking the old topic again revives it', async () => {
    const ev = await app.ok('events:create', { title: 'Vortrag eingereicht', occurredAt: '2026-09-15', topic: 'Konferenz', project: 'Testing Day' });
    await app.ok('events:update', { id: ev.id, patch: { project: null, topic: 'Messe' } });
    expect(await shownNeighbors(ev.id)).toEqual(['Messe']);
    expect(relation(ev.id, projectId('Testing Day'), 'belongs_to')?.status).toBe('outdated');

    await app.ok('events:update', { id: ev.id, patch: { topic: 'Konferenz' } });
    expect(await shownNeighbors(ev.id)).toEqual(['Konferenz']);
    expect(relation(ev.id, topicId('Konferenz'), 'relates_to')?.status).toBe('confirmed');
    expect(relation(ev.id, topicId('Messe'), 'relates_to')?.status).toBe('outdated');
  });

  it('document: topic change only touches topic relations; undo restores, conflicts block undo', async () => {
    const imp = await app.ok('documents:import', { paths: [app.file('in/protokoll.txt', 'Protokoll der Sitzung')] });
    await app.services.jobs.whenIdle();
    const id = imp.imported[0]!.id;
    await app.ok('documents:updateMetadata', { id, topic: 'Budget', confirmed: true });
    const tag = graph().ensureEntity('tag', 'finanzen').id;
    graph().link(id, tag, 'relates_to', { status: 'confirmed', confidence: 0.6 });

    await app.ok('documents:updateMetadata', { id, topic: 'Planung', confirmed: true });
    expect(relation(id, topicId('Budget'), 'relates_to')?.status).toBe('outdated');
    expect(relation(id, tag, 'relates_to')?.status).toBe('confirmed');
    expect((await app.ok('knowledge:getEntity', { id: topicId('Budget') })).relations).toHaveLength(0);

    // the user rejects the new relation afterwards: undo must refuse instead of silently overwriting it
    const fresh = relation(id, topicId('Planung'), 'relates_to')!;
    await app.ok('knowledge:resolveRelation', { relationId: fresh.id, status: 'rejected', confirmed: true });
    const entry = await latestUndoable('document.updateMetadata', 'Planung');
    const blocked = await app.ok('audit:undo', { auditId: entry.id });
    expect(blocked.undone).toBe(false);
    expect(blocked.conflicts.join(' ')).toContain('Verknüpfung');

    // without the conflict the undo restores the previous topic relation
    await app.ok('knowledge:resolveRelation', { relationId: fresh.id, status: 'confirmed', confirmed: true });
    await app.ok('documents:updateMetadata', { id, topic: 'Archiv', confirmed: true });
    expect(relation(id, topicId('Planung'), 'relates_to')?.status).toBe('confirmed'); // confirmed by the user: kept
    expect((await app.ok('audit:undo', { auditId: (await latestUndoable('document.updateMetadata', 'Archiv')).id })).undone).toBe(true);
    expect(relation(id, topicId('Archiv'), 'relates_to')).toBeUndefined();
    expect((await app.ok('documents:get', { id })).topicName).toBe('Planung');
  });

  it('document assign (action) outdates the previous topic', async () => {
    const imp = await app.ok('documents:import', { paths: [app.file('in/a.txt', 'Inhalt A')] });
    await app.services.jobs.whenIdle();
    const id = imp.imported[0]!.id;
    app.services.documents.assign(id, { topic: 'Alt' });
    app.services.documents.assign(id, { topic: 'Neu' });
    expect(relation(id, topicId('Alt'), 'relates_to')?.status).toBe('outdated');
    expect(relation(id, topicId('Neu'), 'relates_to')?.status).toBe('confirmed');
  });

  it('migration backfill marks relations the user resolved before the column existed', async () => {
    const item = await app.ok('openItems:create', { title: 'Punkt', topic: 'Altthema' });
    const rel = graph().link(item.id, topicId('Nebenthema'), 'relates_to', { status: 'proposed' })!;
    await app.ok('knowledge:resolveRelation', { relationId: rel.id, status: 'confirmed', confirmed: true });
    const sqlite = app.services.database.sqlite;
    sqlite.prepare('UPDATE relations SET resolved_by_user = 0').run();
    const sql = fs.readFileSync(path.join(MIGRATIONS, '0006_relation_resolved_by_user.sql'), 'utf8').split('--> statement-breakpoint')[1]!;
    sqlite.exec(sql);
    const flagged = sqlite.prepare('SELECT id FROM relations WHERE resolved_by_user = 1').all() as Array<{ id: string }>;
    expect(flagged.map((r) => r.id)).toEqual([rel.id]);
  });

  it('merge keeps user-rejected relations rejected and user-resolved, undo restores the rows exactly', async () => {
    const source = topicId('Fassade');
    const target = topicId('Fassaden');
    const reject = async (relationId: string) => app.ok('knowledge:resolveRelation', { relationId, status: 'rejected', confirmed: true });
    // moved in place: only a rejected relation to the source
    const moved = await app.ok('openItems:create', { title: 'Punkt eins' });
    const movedRel = graph().link(moved.id, source, 'relates_to', { status: 'proposed' })!;
    await reject(movedRel.id);
    // combined: a rejected relation to the source and a system-confirmed one to the target
    const combined = await app.ok('openItems:create', { title: 'Punkt zwei' });
    const rejectedRel = graph().link(combined.id, source, 'relates_to', { status: 'proposed' })!;
    await reject(rejectedRel.id);
    graph().link(combined.id, target, 'relates_to', { status: 'confirmed' });
    const rows = () => app.services.database.sqlite.prepare('SELECT * FROM relations ORDER BY id').all();
    const before = rows();

    const r = await graph().merge({ sourceIds: [source], targetId: target });
    const flag = (id: string) =>
      app.services.database.sqlite
        .prepare('SELECT status, resolved_by_user AS u FROM relations WHERE source_entity_id = ? AND target_entity_id = ?')
        .get(id, target) as {
        status: string;
        u: number;
      };
    expect(flag(moved.id)).toEqual({ status: 'rejected', u: 1 });
    expect(flag(combined.id)).toEqual({ status: 'rejected', u: 1 });
    // later field sync does not touch them
    await app.ok('openItems:update', { id: combined.id, patch: { title: 'Punkt zwei', topic: 'Dach' } });
    expect(flag(combined.id)).toEqual({ status: 'rejected', u: 1 });
    expect((await app.ok('audit:undo', { auditId: (await latestUndoable('open_item.update')).id })).undone).toBe(true);

    expect((await app.ok('audit:undo', { auditId: r.auditId })).undone).toBe(true);
    expect(rows()).toEqual(before);
  });
});
