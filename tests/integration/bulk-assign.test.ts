import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { archived } from '../helpers/agent';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const subjectsOf = async (id: string) => (await app.ok('subjects:of', { ids: [id] }))[id]!;
const lastAudit = async (action: string) => (await app.ok('audit:list', {})).find((e) => e.action === action)!;

describe('Bulk assignment for several entries (#291)', () => {
  it('topic, project, tag and case for notes, open items and events at once – ONE undo step', async () => {
    app = await createTestApp();
    const c = (await app.ok('cases:create', { name: 'Umzug' })).case;
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Kartons', description: 'Kartons besorgen' })).entity;
    const withTopic = await app.ok('openItems:create', { title: 'Strom ummelden', topic: 'Energie' });
    const without = await app.ok('openItems:create', { title: 'Nachsendeauftrag' });
    const ev = await app.ok('events:create', { title: 'Wohnungsübergabe', occurredAt: '2026-11-01T09:00:00.000Z' });

    const res = await app.ok('entries:bulkAssign', {
      ids: [note.id, withTopic.id, without.id, ev.id],
      topic: 'Wohnen',
      project: 'Umzug 2026',
      tag: 'umzug',
      caseId: c.id,
    });
    expect(res.updated).toBe(4);

    // without a main topic: it becomes the main one; with one: a further one (#287)
    expect((await subjectsOf(without.id)).topic?.name).toBe('Wohnen');
    expect(await subjectsOf(withTopic.id)).toMatchObject({ topic: { name: 'Energie' }, extraTopics: [{ name: 'Wohnen' }] });
    expect((await subjectsOf(ev.id)).project?.name).toBe('Umzug 2026');
    const wohnen = app.services.graph.findByName('topic', 'Wohnen')!.id;
    expect((await app.ok('openItems:list', { topicId: wohnen })).map((i) => i.id).toSorted()).toEqual([withTopic.id, without.id].toSorted());
    expect((await app.ok('timeline:get', { topicId: wohnen })).filter((e) => e.kind === 'event').map((e) => e.title)).toEqual(['Ereignis: Wohnungsübergabe']);
    const tag = app.services.graph.findByName('tag', 'umzug')!.id;
    expect(app.services.graph.relationsOf(note.id).some((r) => r.targetEntityId === tag && r.status === 'confirmed')).toBe(true);
    expect((await app.ok('cases:detail', { id: c.id })).entries).toHaveLength(4);

    // ONE undo step takes all of it back
    const entries = (await app.ok('audit:list', {})).filter((e) => e.action === 'entries.bulkAssign');
    expect(entries).toHaveLength(1);
    expect((await app.ok('audit:undo', { auditId: entries[0]!.id })).undone).toBe(true);
    expect((await subjectsOf(without.id)).topic).toBeNull();
    expect(await subjectsOf(withTopic.id)).toMatchObject({ topic: { name: 'Energie' }, extraTopics: [] });
    expect((await subjectsOf(ev.id)).project).toBeNull();
    expect((await app.ok('cases:detail', { id: c.id })).entries).toEqual([]);
    expect(app.services.graph.relationsOf(note.id).filter((r) => r.targetEntityId === tag && r.status === 'confirmed')).toEqual([]);
  });

  it('documents: a topic is added instead of replaced, a case collects them – one undo step', async () => {
    app = await createTestApp();
    const c = (await app.ok('cases:create', { name: 'Steuer 2025' })).case;
    const a = await archived(app, { name: 'a.md', content: 'Beleg A', folder: 'Privat/steuer', topic: 'Steuer' });
    const b = await archived(app, { name: 'b.md', content: 'Beleg B', folder: 'Privat/steuer' });
    await app.ok('documents:bulkUpdate', { ids: [a, b], addTopic: 'Belege', caseId: c.id, addTags: ['2025'], confirmed: true });
    expect(await subjectsOf(a)).toMatchObject({ topic: { name: 'Steuer' }, extraTopics: [{ name: 'Belege' }] });
    expect((await subjectsOf(b)).topic?.name).toBe('Belege');
    expect((await app.ok('cases:detail', { id: c.id })).entries.map((e) => e.id).toSorted()).toEqual([a, b].toSorted());

    await app.ok('audit:undo', { auditId: (await lastAudit('document.bulkUpdate')).id });
    expect(await subjectsOf(a)).toMatchObject({ topic: { name: 'Steuer' }, extraTopics: [] });
    expect((await subjectsOf(b)).topic).toBeNull();
    expect((await app.ok('cases:detail', { id: c.id })).entries).toEqual([]);
  });
});
