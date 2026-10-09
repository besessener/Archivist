import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => app.cleanup());

const deleteAudit = async () => (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'open_item.delete')!;

describe('Deleting an open item with undo', () => {
  it('removes the item with reminder, graph node and search hit, and undo restores them', async () => {
    const item = await app.ok('openItems:create', { title: 'Dachrinne reparieren', topic: 'Haus', priority: 'normal', sourceIds: [], confidence: 0.9 });
    await app.ok('reminders:create', { targetType: 'open_item', targetId: item.id, title: 'Dachrinne', remindAt: '2099-01-01T08:00:00.000Z' });
    await app.services.openItems.reindex(item.id);

    await app.ok('openItems:delete', { id: item.id, confirmed: true });
    expect(await app.ok('openItems:list', {})).toHaveLength(0);
    expect(app.services.graph.getEntity(item.id)).toBeUndefined();
    expect(await app.ok('reminders:list', {})).toHaveLength(0);
    expect((await app.services.search.search('Dachrinne', { types: ['task'] })).map((h) => h.id)).not.toContain(item.id);

    const res = await app.ok('audit:undo', { auditId: (await deleteAudit()).id });
    expect(res).toMatchObject({ undone: true, conflicts: [], message: 'Offener Punkt wiederhergestellt.' });
    expect(app.services.openItems.get(item.id)).toMatchObject({ title: 'Dachrinne reparieren', topicName: 'Haus', reminderAt: '2099-01-01T08:00:00.000Z' });
    expect(await app.ok('reminders:list', { status: 'pending' })).toHaveLength(1);
    expect(app.services.graph.getEntity(item.id)).toBeDefined();
  });

  it('refuses without confirmation, and undo works only once', async () => {
    const item = await app.ok('openItems:create', { title: 'Steuererklärung', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const rejected = await app.call('openItems:delete', { id: item.id, confirmed: false as never });
    expect(rejected.ok).toBe(false);
    expect(app.services.openItems.get(item.id).title).toBe('Steuererklärung');

    await app.ok('openItems:delete', { id: item.id, confirmed: true });
    const { id } = await deleteAudit();
    expect((await app.ok('audit:undo', { auditId: id })).undone).toBe(true);
    expect((await app.ok('audit:undo', { auditId: id })).undone).toBe(false);
  });

  it('leaves the item, its reminder and search hit in place when the audit entry cannot be written', async () => {
    const item = await app.ok('openItems:create', { title: 'Heizung entlüften', priority: 'normal', sourceIds: [], confidence: 0.9 });
    await app.ok('reminders:create', { targetType: 'open_item', targetId: item.id, title: 'Heizung', remindAt: '2099-01-01T08:00:00.000Z' });
    await app.services.openItems.reindex(item.id);
    vi.spyOn(app.services.audit, 'log').mockImplementationOnce(() => {
      throw new Error('audit log unavailable');
    });

    expect((await app.call('openItems:delete', { id: item.id, confirmed: true })).ok).toBe(false);

    expect(app.services.openItems.get(item.id).title).toBe('Heizung entlüften');
    expect(app.services.graph.getEntity(item.id)).toBeDefined();
    expect(await app.ok('reminders:list', {})).toHaveLength(1);
    expect((await app.services.search.search('Heizung', { types: ['task'] })).map((h) => h.id)).toContain(item.id);
  });
});
