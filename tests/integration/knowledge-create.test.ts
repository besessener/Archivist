import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcContract } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

const searchIds = async (query: string) => (await app.ok('search:global', { query })).map((h) => h.id);

describe('knowledge:createEntity ("Neu anlegen" on the knowledge page)', () => {
  it('creates a topic once and reports an existing one instead of claiming it was created', async () => {
    const first = await app.ok('knowledge:createEntity', { type: 'topic', name: 'Hauskauf', description: 'Alles rund ums Haus' });
    expect(first.created).toBe(true);
    expect(first.entity).toMatchObject({ type: 'topic', name: 'Hauskauf', description: 'Alles rund ums Haus' });

    const again = await app.ok('knowledge:createEntity', { type: 'topic', name: '  hauskauf ' });
    expect(again.created).toBe(false);
    expect(again.entity.id).toBe(first.entity.id);
    expect(await app.ok('knowledge:listEntities', { type: 'topic' })).toHaveLength(1);

    // a remembered alias (e.g. from a merge) also counts as existing
    app.services.graph.addAlias(first.entity.id, 'Hauskauf Musterstraße');
    const viaAlias = await app.ok('knowledge:createEntity', { type: 'topic', name: 'Hauskauf Musterstrasse' });
    expect(viaAlias).toMatchObject({ created: false, entity: { id: first.entity.id } });

    // the same name with another type is a different entry
    const project = await app.ok('knowledge:createEntity', { type: 'project', name: 'Hauskauf' });
    expect(project.created).toBe(true);
    expect(project.entity.id).not.toBe(first.entity.id);
  });

  it('creates a real, dated event record that shows up in timeline, events list and search', async () => {
    const r = await app.ok('knowledge:createEntity', {
      type: 'event',
      title: 'Beitrag beim Testing Day eingereicht',
      occurredAt: '2026-10-01',
      description: 'Vortrag über Archivist',
      topic: 'Konferenzen',
    });
    expect(r.created).toBe(true);
    expect(r.entity.type).toBe('event');

    const events = await app.ok('events:list', {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: r.entity.id, occurredAt: '2026-10-01', topicName: 'Konferenzen' });
    const timeline = await app.ok('timeline:get', {});
    expect(timeline.some((e) => e.kind === 'event' && e.id === `event:${r.entity.id}` && e.date === '2026-10-01')).toBe(true);
    await vi.waitFor(async () => expect(await searchIds('Testing Day')).toContain(r.entity.id));
    expect(app.services.audit.list({ limit: 50 }).some((a) => a.action === 'event.create' && a.entityIds.includes(r.entity.id))).toBe(true);
  });

  it('reports an identical event (same title, same day) as existing and keeps other dates separate', async () => {
    const first = await app.ok('knowledge:createEntity', { type: 'event', title: 'Umzug', occurredAt: '2026-03-01' });
    const same = await app.ok('knowledge:createEntity', { type: 'event', title: 'umzug', occurredAt: '2026-03-01' });
    expect(same.created).toBe(false);
    expect(same.entity.id).toBe(first.entity.id);
    const other = await app.ok('knowledge:createEntity', { type: 'event', title: 'Umzug', occurredAt: '2027-03-01' });
    expect(other.created).toBe(true);
    expect(await app.ok('events:list', {})).toHaveLength(2);
  });

  it('rejects an event without a valid date', async () => {
    const r = await app.call('knowledge:createEntity', { type: 'event', title: 'Ohne Datum', occurredAt: 'irgendwann' });
    expect(r.ok).toBe(false);
    expect(await app.ok('events:list', {})).toHaveLength(0);
  });

  it('creates an indexed note and reports an identical note as existing', async () => {
    const r = await app.ok('knowledge:createEntity', { type: 'note', name: 'Einkaufsliste', description: 'Milch, Brot und Kaffeebohnen' });
    expect(r.created).toBe(true);
    expect(r.entity).toMatchObject({ type: 'note', name: 'Einkaufsliste', description: 'Milch, Brot und Kaffeebohnen' });
    expect(await searchIds('Kaffeebohnen')).toContain(r.entity.id);

    const same = await app.ok('knowledge:createEntity', { type: 'note', name: 'einkaufsliste', description: 'Milch,  Brot und kaffeebohnen' });
    expect(same.created).toBe(false);
    expect(same.entity.id).toBe(r.entity.id);

    // same title, different content: a separate note, nothing is overwritten
    const other = await app.ok('knowledge:createEntity', { type: 'note', name: 'Einkaufsliste', description: 'Schrauben und Dübel' });
    expect(other.created).toBe(true);
    expect(other.entity.id).not.toBe(r.entity.id);
    expect(app.services.graph.getEntity(r.entity.id)?.description).toBe('Milch, Brot und Kaffeebohnen');
    expect(await searchIds('Kaffeebohnen')).toContain(r.entity.id);
    expect(await searchIds('Dübel')).toContain(other.entity.id);
  });

  it('uses the title as content for a note without text', async () => {
    const r = await app.ok('knowledge:createEntity', { type: 'note', name: 'Zahnarzt anrufen' });
    expect(r.created).toBe(true);
    expect(r.entity.description).toBe('Zahnarzt anrufen');
    expect(await searchIds('Zahnarzt')).toContain(r.entity.id);
  });

  it('validates input and output against the IPC contract', async () => {
    const spec = ipcContract['knowledge:createEntity'];
    expect(spec.input.safeParse({ type: 'event', name: 'x' }).success).toBe(false);
    expect(spec.input.safeParse({ type: 'event', title: 'x', occurredAt: '2026-01-01' }).success).toBe(true);
    expect(spec.input.safeParse({ type: 'topic', name: '   ' }).success).toBe(false);
    expect(spec.input.safeParse({ type: 'document', name: 'x' }).success).toBe(false);
    const out = await app.ok('knowledge:createEntity', { type: 'person', name: 'Anna' });
    expect(spec.output.safeParse(out).success).toBe(true);
  });
});

describe('NoteService (single note-creation path)', () => {
  it('keeps notes with the same beginning apart instead of merging them by their first 70 characters', async () => {
    const prefix = 'Gedanken zur Planung des Sommerfests im Garten mit allen Nachbarn und Freunden, ';
    const a = await app.services.notes.createUnlessExists({ content: `${prefix}Teil eins über Getränke.` });
    const b = await app.services.notes.createUnlessExists({ content: `${prefix}Teil zwei über das Essen.` });
    expect(a.created && b.created).toBe(true);
    expect(a.note.id).not.toBe(b.note.id);
    expect(a.note.name).toBe(b.note.name);
    expect(app.services.graph.getEntity(a.note.id)?.description).toContain('Getränke');
    expect(app.services.graph.getEntity(b.note.id)?.description).toContain('Essen');

    const again = await app.services.notes.createUnlessExists({ content: `${prefix}Teil eins über Getränke.` });
    expect(again).toMatchObject({ created: false, note: { id: a.note.id } });
  });

  it('create() always adds a new note and links it', async () => {
    const topic = app.services.graph.ensureEntity({ type: 'topic', name: 'Garten' });
    const n1 = await app.services.notes.create({ content: 'Rasen mähen', links: [{ targetId: topic.id, relationType: 'relates_to' }] });
    const n2 = await app.services.notes.create({ content: 'Rasen mähen' });
    expect(n1.id).not.toBe(n2.id);
    const detail = await app.ok('knowledge:getEntity', { id: topic.id });
    expect(detail.relations.some((r) => r.other.id === n1.id && r.status === 'confirmed')).toBe(true);
    await expect(app.services.notes.create({ content: '   ' })).rejects.toThrow(/Inhalt/);
  });
});
