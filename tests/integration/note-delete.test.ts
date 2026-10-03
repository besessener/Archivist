import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => {
  await app.cleanup();
});

describe('Deleting a note (#248)', () => {
  it('removes it from graph and search and can be undone', async () => {
    const note = await app.services.notes.create({ title: 'Mietvertrag Hauptstraße', content: 'Mietvertrag Hauptstraße' });
    expect((await app.services.search.search('Mietvertrag', { limit: 5 })).map((hit) => hit.id)).toContain(note.id);

    await app.ok('knowledge:deleteNote', { id: note.id, confirmed: true });

    expect(app.services.graph.getEntity(note.id)).toBeUndefined();
    expect((await app.services.search.search('Mietvertrag', { limit: 5 })).map((hit) => hit.id)).not.toContain(note.id);

    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'note.delete')!;
    await app.ok('audit:undo', { auditId: entry.id });

    expect(app.services.graph.getEntity(note.id)?.name).toBe('Mietvertrag Hauptstraße');
    expect((await app.services.search.search('Mietvertrag', { limit: 5 })).map((hit) => hit.id)).toContain(note.id);
  });

  it('needs the explicit confirmation and only deletes notes', async () => {
    const note = await app.services.notes.create({ title: 'Notiz', content: 'Inhalt der Notiz' });
    const topic = app.services.graph.ensureEntity({ type: 'topic', name: 'Hauskauf' });

    expect((await app.call('knowledge:deleteNote', { id: note.id, confirmed: false as unknown as true })).ok).toBe(false);
    expect(app.services.graph.getEntity(note.id)).toBeDefined();
    expect(() => app.services.notes.delete(topic.id, { confirmed: true })).toThrow(/Notiz/);
  });
});
