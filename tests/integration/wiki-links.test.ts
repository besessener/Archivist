import { afterEach, describe, expect, it } from 'vitest';
import { wikiNames } from '../../packages/core/src/services/wiki-links';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app?.cleanup();
});

const wikiRelations = (noteId: string) =>
  app.services.graph.relationsOf(noteId).filter((r) => r.method === 'wikilink' && r.sourceEntityId === noteId && r.status !== 'rejected');
const targets = (noteId: string) =>
  wikiRelations(noteId)
    .map((r) => r.targetEntityId)
    .toSorted();
const relationTo = (noteId: string, targetId: string) =>
  app.services.graph.relationsOf(noteId).find((r) => r.sourceEntityId === noteId && r.targetEntityId === targetId);
const create = async (type: 'note' | 'project' | 'topic' | 'person', name: string, description?: string) =>
  (await app.ok('knowledge:createEntity', { type, name, ...(description ? { description } : {}) })).entity;

describe('Wiki links [[Name]] in notes (#285)', () => {
  it('parses each linked name once, also with a shown text', () => {
    expect(wikiNames('Siehe [[Hausbau]] und [[ hausbau ]], dazu [[Anna Schmidt|Anna]]. Kein [[]] oder [[a\nb]].')).toEqual(['Hausbau', 'Anna Schmidt']);
  });

  it('saving creates confirmed manual relations; removing a link removes its relation; undo brings it back', async () => {
    app = await createTestApp();
    const project = await create('project', 'Hausbau');
    const anna = await create('person', 'Anna Schmidt');
    const note = await create('note', 'Baustelle', 'Termin zu [[Hausbau]] mit [[Anna Schmidt|Anna]].');

    expect(targets(note.id)).toEqual([project.id, anna.id].toSorted());
    expect(wikiRelations(note.id)[0]).toMatchObject({ status: 'confirmed', origin: 'user', relationType: 'relates_to' });
    expect(
      wikiRelations(note.id)
        .map((r) => r.evidence)
        .toSorted(),
    ).toEqual(['[[Anna Schmidt]]', '[[Hausbau]]']);

    await app.ok('knowledge:updateNote', { id: note.id, content: 'Termin zu [[Hausbau]] ohne Anna.' });
    expect(targets(note.id)).toEqual([project.id]);

    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'note.update')!;
    await app.ok('audit:undo', { auditId: entry.id });
    expect(targets(note.id)).toEqual([project.id, anna.id].toSorted());
  });

  it("a link written over an analysis proposal becomes the user's link: no later analysis outdates it, removing the link removes it", async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    const topic = await create('topic', 'Finanzen');
    let analysedTopic: string | null = 'Finanzen';
    app.llm.on('NoteAnalysis', () => ({ topic: analysedTopic, project: null, persons: [], tags: [] }));
    const note = await create('note', 'Bank', 'Kreditgespräch bei der Bank.');
    await app.services.jobs.whenIdle();
    const proposal = relationTo(note.id, topic.id)!;
    expect(proposal).toMatchObject({ method: 'analysis', status: 'proposed' });

    analysedTopic = null;
    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch bei der Bank, siehe [[Finanzen]].' });
    await app.services.jobs.whenIdle();
    expect(relationTo(note.id, topic.id)).toMatchObject({
      id: proposal.id,
      status: 'confirmed',
      method: 'wikilink',
      origin: 'user',
      resolvedByUser: true,
      evidence: '[[Finanzen]]',
    });

    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch bei der Bank.' });
    await app.services.jobs.whenIdle();
    expect(relationTo(note.id, topic.id)).toBeUndefined();
  });

  it('a link written over a rejected relation confirms it; undoing the edit restores the rejection', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    const topic = await create('topic', 'Finanzen');
    app.llm.on('NoteAnalysis', () => ({ topic: 'Finanzen', project: null, persons: [], tags: [] }));
    const note = await create('note', 'Bank', 'Kreditgespräch bei der Bank.');
    await app.services.jobs.whenIdle();
    const proposal = relationTo(note.id, topic.id)!;
    app.services.graph.setRelationStatus(proposal.id, { status: 'rejected' });

    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch bei der Bank, siehe [[Finanzen]].' });
    await app.services.jobs.whenIdle();
    expect(relationTo(note.id, topic.id)).toMatchObject({ id: proposal.id, status: 'confirmed', method: 'wikilink', resolvedByUser: true });

    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'note.update')!;
    await app.ok('audit:undo', { auditId: entry.id });
    await app.services.jobs.whenIdle();
    expect(relationTo(note.id, topic.id)).toMatchObject({ id: proposal.id, status: 'rejected', method: 'analysis', resolvedByUser: true });
  });

  it('an unrelated edit keeps a rejected wiki link rejected while its [[Name]] stays in the text', async () => {
    app = await createTestApp();
    const topic = await create('topic', 'Finanzen');
    const note = await create('note', 'Bank', 'Kreditgesprach zu [[Finanzen]].');
    const link = relationTo(note.id, topic.id)!;
    app.services.graph.setRelationStatus(link.id, { status: 'rejected' });

    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch zu [[Finanzen]].' });
    expect(relationTo(note.id, topic.id)).toMatchObject({ id: link.id, status: 'rejected', method: 'wikilink' });
  });

  it('an unrelated edit leaves a rejected or proposed relation alone while its [[Name]] was already in the text', async () => {
    app = await createTestApp();
    const note = await create('note', 'Bank', 'Kreditgesprach zu [[Finanzen]] und [[Hausbau]].');
    const topic = await create('topic', 'Finanzen');
    const project = await create('project', 'Hausbau');
    const relates = (targetId: string) =>
      app.services.graph.link({ sourceId: note.id, targetId, relationType: 'relates_to' }, { status: 'proposed', method: 'analysis' })!;
    const rejected = relates(topic.id);
    app.services.graph.setRelationStatus(rejected.id, { status: 'rejected' });
    const proposal = relates(project.id);

    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch zu [[Finanzen]] und [[Hausbau]].' });
    expect(relationTo(note.id, topic.id)).toMatchObject({ id: rejected.id, status: 'rejected', method: 'analysis' });
    expect(relationTo(note.id, project.id)).toMatchObject({ id: proposal.id, status: 'proposed', method: 'analysis' });

    const edit = (await app.ok('audit:list', {})).find((e) => e.action === 'note.update')!;
    await app.ok('audit:undo', { auditId: edit.id });
    expect(relationTo(note.id, topic.id)).toMatchObject({ id: rejected.id, status: 'rejected', method: 'analysis' });

    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch.' });
    await app.ok('knowledge:updateNote', { id: note.id, content: 'Kreditgespräch zu [[Hausbau]].' });
    expect(relationTo(note.id, project.id)).toMatchObject({ id: proposal.id, status: 'confirmed', method: 'wikilink', resolvedByUser: true });
  });

  it('renaming or merging the target keeps the link', async () => {
    app = await createTestApp();
    const project = await create('project', 'Hausbau');
    const note = await create('note', 'Baustelle', 'Siehe [[Hausbau]].');
    await app.services.graph.rename({ id: project.id, name: 'Neubau Gartenstraße' });
    await app.ok('knowledge:updateNote', { id: note.id, content: 'Siehe [[Hausbau]], Stand Oktober.' });
    expect(targets(note.id)).toEqual([project.id]);
    expect((await app.ok('knowledge:wikiResolve', { names: ['Hausbau'], noteId: note.id }))[0]!.entity?.id).toBe(project.id);

    const topic = await create('topic', 'Garten');
    const note2 = await create('note', 'Beet', 'Mehr zu [[Garten]].');
    const other = await create('topic', 'Gartenarbeit');
    await app.services.graph.merge({ sourceIds: [topic.id], targetId: other.id });
    expect(targets(note2.id)).toEqual([other.id]);
    await app.ok('knowledge:updateNote', { id: note2.id, content: 'Mehr zu [[Garten]] im Frühjahr.' });
    expect(targets(note2.id)).toEqual([other.id]);
  });

  it("an exact name wins over another entry's alias, and an alias alone resolves", async () => {
    app = await createTestApp();
    const exact = await create('topic', 'Eigenheim');
    const project = await create('project', 'Hausbau');
    app.services.graph.addAlias(project.id, 'Eigenheim');
    const alias = await create('project', 'Neubau');
    app.services.graph.addAlias(alias.id, 'Rohbau');
    const note = await create('note', 'Idee', 'Zu [[Eigenheim]] und [[Rohbau]].');
    expect(targets(note.id).toSorted()).toEqual([exact.id, alias.id].toSorted());
  });

  it('unknown names are reported; autocomplete finds names and aliases', async () => {
    app = await createTestApp();
    const project = await create('project', 'Hausbau');
    app.services.graph.addAlias(project.id, 'Eigenheim');
    const note = await create('note', 'Idee', 'Frag [[Niemand Bekanntes]] zu [[Eigenheim]].');
    expect(targets(note.id)).toEqual([project.id]);
    const resolved = await app.ok('knowledge:wikiResolve', { names: ['Niemand Bekanntes', 'Eigenheim'], noteId: note.id });
    expect(resolved).toEqual([
      { name: 'Niemand Bekanntes', entity: null },
      { name: 'Eigenheim', entity: { id: project.id, type: 'project', name: 'Hausbau' } },
    ]);

    expect((await app.ok('knowledge:wikiSuggest', { query: 'haus' })).map((s) => s.name)).toContain('Hausbau');
    expect(await app.ok('knowledge:wikiSuggest', { query: 'eigen' })).toEqual([{ id: project.id, type: 'project', name: 'Hausbau', alias: 'Eigenheim' }]);
    expect((await app.ok('knowledge:wikiSuggest', { query: 'idee', excludeId: note.id })).map((s) => s.id)).not.toContain(note.id);
  });
});
