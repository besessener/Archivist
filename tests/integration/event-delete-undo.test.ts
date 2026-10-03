import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

const deleteAudit = async () => (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'event.delete')!;

describe('Deleting an event with undo', () => {
  it('restores a deleted event exactly, with topic, project, links and search hit', async () => {
    const ev = await app.ok('events:create', {
      title: 'Beitrag beim German Testing Day eingereicht',
      occurredAt: '2026-10-01',
      description: 'Vortrag über Mutationstests',
      topic: 'Konferenzbeitrag',
      project: 'Testing Day',
    });
    const person = app.services.graph.ensureEntity({ type: 'person', name: 'Anna Schmidt' });
    app.services.graph.link(
      { sourceId: person.id, targetId: ev.id, relationType: 'participated_in' },
      { confidence: 0.7, status: 'confirmed', resolvedByUser: true },
    );
    const before = app.services.graph.getDetail(ev.id);

    await app.ok('events:delete', { id: ev.id, confirmed: true });
    expect(await app.ok('events:list', {})).toHaveLength(0);
    expect(app.services.graph.getEntity(ev.id)).toBeUndefined();
    expect((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'event')).toBe(false);

    const entry = await deleteAudit();
    expect(entry).toMatchObject({ undoable: true, entityIds: [ev.id] });
    const res = await app.ok('audit:undo', { auditId: entry.id });
    expect(res).toMatchObject({ undone: true, conflicts: [], message: 'Ereignis wiederhergestellt.' });

    expect(await app.ok('events:list', {})).toEqual([ev]);
    const after = app.services.graph.getDetail(ev.id);
    expect(after.relations.map((r) => r.id).sort()).toEqual(before.relations.map((r) => r.id).sort());
    expect(after.relations.find((r) => r.other.id === person.id)).toMatchObject({ status: 'confirmed', confidence: 0.7 });
    await app.services.eventRecords.reindex(ev.id);
    expect((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'event' && h.id === ev.id)).toBe(true);
    expect((await app.ok('timeline:get', {})).some((e) => e.id === `event:${ev.id}`)).toBe(true);
  });

  it('can be undone only once', async () => {
    const ev = await app.ok('events:create', { title: 'Release', occurredAt: '2026-09-01' });
    await app.ok('events:delete', { id: ev.id, confirmed: true });
    const entry = await deleteAudit();
    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(true);
    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(false);
    expect(await app.ok('events:list', {})).toHaveLength(1);
  });

  it('restores the event even when the topic has since been removed, and reports that', async () => {
    const ev = await app.ok('events:create', { title: 'Kick-off', occurredAt: '2026-09-15', topic: 'Alte Planung' });
    await app.ok('events:delete', { id: ev.id, confirmed: true });
    app.services.graph.removeNode(ev.topicId!);

    const res = await app.ok('audit:undo', { auditId: (await deleteAudit()).id });
    expect(res.undone).toBe(true);
    expect(res.message).toMatch(/Nicht wiederhergestellt, weil inzwischen entfernt: das Thema, eine Verknüpfung/);
    const [restored] = await app.ok('events:list', {});
    expect(restored).toMatchObject({ id: ev.id, title: 'Kick-off', topicId: null, topicName: null });
    expect(app.services.graph.getDetail(ev.id).relations).toHaveLength(0);
  });
});
