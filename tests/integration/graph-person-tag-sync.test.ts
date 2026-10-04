import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';
import { intent } from '../helpers/chat-intents';

/** Issue #274: persons and tags in the graph always match the fields of an entry. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const personId = (name: string) => graph().findByName('person', name)?.id;
const tagId = (name: string) => graph().findByName('tag', name)?.id;
/** Status of the relation `from → to` of `type` (undefined: none). */
const relStatus = (from: string | undefined, to: string, type: string) =>
  graph()
    .relationsOf(to)
    .find((r) => r.sourceEntityId === from && r.targetEntityId === to && r.relationType === type)?.status;
const lastAudit = async (action: string) => (await app.ok('audit:list', {})).find((a) => a.action === action)!;

async function archived(persons: string[], tags: string[]): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Protokoll', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes', docType: 'Protokoll', persons, tags }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file('in/protokoll.txt', 'Protokoll der Sitzung')] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'Arbeit/notes' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

describe('editing an archived document', () => {
  it('syncs the relations to persons and tags; confirmed or rejected ones stay; undo restores the previous state', async () => {
    const id = await archived(['Anna Albers', 'Bernd Brandt', 'Carla Conrad'], ['budget', 'reise']);
    expect(relStatus(personId('Anna Albers'), id, 'mentioned_in')).toBe('confirmed');
    expect(relStatus(id, tagId('reise')!, 'relates_to')).toBe('confirmed');
    // the user confirmed that Carla belongs to the document
    const carla = graph()
      .relationsOf(id)
      .find((r) => r.sourceEntityId === personId('Carla Conrad'))!;
    await app.ok('knowledge:resolveRelation', { relationId: carla.id, status: 'confirmed', confirmed: true });

    await app.ok('documents:updateMetadata', { id, persons: ['Anna Albers', 'Dora Dietz'], tags: ['budget', 'umzug'], confirmed: true });

    expect(relStatus(personId('Anna Albers'), id, 'mentioned_in')).toBe('confirmed');
    expect(relStatus(personId('Dora Dietz'), id, 'mentioned_in')).toBe('confirmed');
    expect(relStatus(personId('Bernd Brandt'), id, 'mentioned_in')).toBe('outdated');
    expect(relStatus(personId('Carla Conrad'), id, 'mentioned_in')).toBe('confirmed'); // a user decision is kept
    expect(relStatus(id, tagId('umzug')!, 'relates_to')).toBe('confirmed');
    expect(relStatus(id, tagId('reise')!, 'relates_to')).toBe('outdated');
    expect(relStatus(id, tagId('budget')!, 'relates_to')).toBe('confirmed');

    const res = await app.ok('audit:undo', { auditId: (await lastAudit('document.updateMetadata')).id });
    expect(res.undone).toBe(true);
    const doc = await app.ok('documents:get', { id });
    expect(doc.persons).toEqual(['Anna Albers', 'Bernd Brandt', 'Carla Conrad']);
    expect(doc.tags).toEqual(['budget', 'reise']);
    expect(relStatus(personId('Bernd Brandt'), id, 'mentioned_in')).toBe('confirmed');
    expect(relStatus(personId('Dora Dietz'), id, 'mentioned_in')).toBeUndefined();
    expect(relStatus(id, tagId('reise')!, 'relates_to')).toBe('confirmed');
    expect(relStatus(id, tagId('umzug')!, 'relates_to')).toBeUndefined();
  });

  it('archiving links every person and every tag (no longer only 12 persons and 8 tags)', async () => {
    const persons = Array.from({ length: 15 }, (_, i) => `Person Nummer${String.fromCharCode(65 + i)}`);
    const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    const id = await archived(persons, tags);
    for (const p of persons) expect(relStatus(personId(p), id, 'mentioned_in'), p).toBe('confirmed');
    for (const t of tags) expect(relStatus(id, tagId(t)!, 'relates_to'), t).toBe('confirmed');
    expect((await app.ok('documents:get', { id })).persons).toHaveLength(15);
  });
});

describe('responsible person of an open item', () => {
  it('is a relation in the graph that follows changes and their undo', async () => {
    const item = await app.ok('openItems:create', { title: 'Angebot einholen', responsible: 'Erik Eller' });
    expect(relStatus(personId('Erik Eller'), item.id, 'responsible_for')).toBe('confirmed');

    await app.ok('openItems:update', { id: item.id, patch: { responsible: 'Fiona Falk' } });
    expect(relStatus(personId('Fiona Falk'), item.id, 'responsible_for')).toBe('confirmed');
    expect(relStatus(personId('Erik Eller'), item.id, 'responsible_for')).toBe('outdated');

    await app.ok('openItems:update', { id: item.id, patch: { responsible: null } });
    expect(relStatus(personId('Fiona Falk'), item.id, 'responsible_for')).toBe('outdated');

    await app.ok('audit:undo', { auditId: (await lastAudit('open_item.update')).id });
    expect(app.services.openItems.get(item.id).responsibleName).toBe('Fiona Falk');
    expect(relStatus(personId('Fiona Falk'), item.id, 'responsible_for')).toBe('confirmed');
  });
});

describe('participants of an event', () => {
  it('are stored, linked in the graph, follow edits and their undo', async () => {
    const ev = await app.ok('events:create', { title: 'Kickoff', occurredAt: '2026-03-03', participants: ['Gina Graf', 'Hugo Horn'], sourceIds: [] });
    expect(ev.participants).toEqual(['Gina Graf', 'Hugo Horn']);
    expect(relStatus(personId('Gina Graf'), ev.id, 'participated_in')).toBe('confirmed');

    const upd = await app.ok('events:update', { id: ev.id, patch: { participants: ['Hugo Horn', 'Ida Igel'] } });
    expect(upd.participants).toEqual(['Hugo Horn', 'Ida Igel']);
    expect(relStatus(personId('Gina Graf'), ev.id, 'participated_in')).toBe('outdated');
    expect(relStatus(personId('Ida Igel'), ev.id, 'participated_in')).toBe('confirmed');

    await app.ok('audit:undo', { auditId: (await lastAudit('event.update')).id });
    const back = app.services.eventRecords.get(ev.id);
    expect(back.participants).toEqual(['Gina Graf', 'Hugo Horn']);
    expect(relStatus(personId('Gina Graf'), ev.id, 'participated_in')).toBe('confirmed');
    expect(relStatus(personId('Ida Igel'), ev.id, 'participated_in')).toBeUndefined();

    // an edit without participants leaves them unchanged
    expect((await app.ok('events:update', { id: ev.id, patch: { title: 'Kickoff-Termin' } })).participants).toEqual(['Gina Graf', 'Hugo Horn']);
  });

  it('can be given in the chat', async () => {
    app.llm.on('ChatIntent', () =>
      intent({ intent: 'event_record', event: { title: 'Workshop gehalten', occurredAt: '2026-09-10', participants: ['Jana Jung'] } }),
    );
    const r = await app.ok('chat:send', { text: 'Am 10.09.2026 habe ich mit Jana Jung den Workshop gehalten.' });
    expect(r.assistantMessage.content).toContain('Beteiligte: Jana Jung');
    const ev = app.services.eventRecords.list()[0]!;
    expect(ev.participants).toEqual(['Jana Jung']);
    expect(relStatus(personId('Jana Jung'), ev.id, 'participated_in')).toBe('confirmed');
  });

  it('follow a merge of persons', async () => {
    const ev = await app.ok('events:create', { title: 'Abnahme', occurredAt: '2026-04-01', participants: ['K. Kraus'], sourceIds: [] });
    const target = await app.ok('knowledge:createEntity', { type: 'person', name: 'Karl Kraus' } as never);
    await graph().mergeMany([{ targetId: target.entity.id, sourceIds: [personId('K. Kraus')!] }]);
    expect(app.services.eventRecords.get(ev.id).participants).toEqual(['Karl Kraus']);
    expect(relStatus(target.entity.id, ev.id, 'participated_in')).toBe('confirmed');
  });
});
