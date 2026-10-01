import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Insight } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const check = () => app.services.consistency.run('manual');
const questions = async (status?: Insight['status']) => (await app.ok('insights:list', { status })).filter((i) => i.kind === 'topic_project_name');

/** Topic „prod-plat“ and project „Prod Plat“, each referenced by records. */
async function seed() {
  const ev = await app.ok('events:create', { title: 'Kickoff', occurredAt: '2026-09-03', topic: 'prod-plat', sourceIds: [] });
  const dec = await app.ok('decisions:create', {
    decisionText: 'prod-plat geht live',
    title: 'prod-plat geht live',
    decidedAt: '2026-09-01',
    participants: ['Anna'],
    topic: 'prod-plat',
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });
  const item = await app.ok('openItems:create', { title: 'Release planen', project: 'Prod Plat', priority: 'normal', sourceIds: [], confidence: 0.9 });
  const topic = graph().findByName('topic', 'prod-plat')!;
  const project = graph().findByName('project', 'Prod Plat')!;
  expect(topic && project).toBeTruthy();
  return { ev, dec, item, topic, project };
}

async function askedQuestion(): Promise<Insight> {
  await check();
  const open = await questions('open');
  expect(open).toHaveLength(1);
  return open[0]!;
}

describe('Gleicher Name als Thema und als Projekt (#31)', () => {
  it('fragt „Projekt oder Thema?“ mit drei Antworten', async () => {
    const { topic, project } = await seed();
    await app.ok('knowledge:createEntity', { type: 'topic', name: 'Nur Thema' });

    const report = await check();
    const [q, ...rest] = await questions('open');

    expect(rest).toHaveLength(0);
    expect(report.byKind.topic_project_name).toBe(1);
    expect(q!.title).toBe('Ist ‚prod-plat‘ ein Projekt oder ein Thema?');
    expect(q!.choices.map((c) => c.label)).toEqual(['Projekt', 'Thema', 'Beides ist richtig (verschieden)']);
    expect(q!.choices.map((c) => c.actionId === null)).toEqual([false, false, true]);
    expect(q!.affected.map((e) => e.id).sort()).toEqual([topic.id, project.id].sort());
    expect(q!.chosenChoiceId).toBeNull();

    // a second run neither duplicates the question nor proposes new actions
    const actionsBefore = app.services.actions.list().length;
    await check();
    expect(await questions()).toHaveLength(1);
    expect(app.services.actions.list()).toHaveLength(actionsBefore);
  });

  it('„Projekt“ führt beide zum Projekt zusammen, hängt alle Verweise um und lässt sich rückgängig machen', async () => {
    const { ev, dec, item, topic, project } = await seed();
    const q = await askedQuestion();
    const topicChoice = q.choices.find((c) => c.id === 'topic')!;

    const answered = await app.ok('insights:respond', { response: 'choose', id: q.id, choiceId: 'project', confirmed: true, strongConfirmed: false });

    expect(answered).toMatchObject({ status: 'accepted', chosenChoiceId: 'project' });
    expect(graph().getEntity(topic.id)).toBeUndefined();
    expect(graph().getEntity(project.id)).toMatchObject({ type: 'project', name: 'Prod Plat' });
    expect(app.services.eventRecords.get(ev.id)).toMatchObject({ topicId: null, projectId: project.id });
    expect(app.services.decisions.get(dec.id)).toMatchObject({ topicId: null, projectId: project.id });
    expect(app.services.openItems.get(item.id)).toMatchObject({ projectId: project.id });
    // the alternative answer's action is withdrawn
    expect(app.services.actions.get(topicChoice.actionId!).status).toBe('rejected');

    const merge = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'entity.merge')!;
    expect(merge).toBeDefined();
    expect((await app.ok('audit:undo', { auditId: merge.id })).undone).toBe(true);
    expect(graph().getEntity(topic.id)).toMatchObject({ type: 'topic', name: 'prod-plat' });
    expect(app.services.decisions.get(dec.id)).toMatchObject({ topicId: topic.id, projectId: null });
  });

  it('„Thema“ führt beide zum Thema zusammen', async () => {
    const { ev, item, topic, project } = await seed();
    const q = await askedQuestion();

    await app.ok('insights:respond', { response: 'choose', id: q.id, choiceId: 'topic', confirmed: true, strongConfirmed: false });

    expect(graph().getEntity(project.id)).toBeUndefined();
    expect(graph().getEntity(topic.id)).toMatchObject({ type: 'topic' });
    expect(app.services.openItems.get(item.id)).toMatchObject({ topicId: topic.id, projectId: null });
    expect(app.services.eventRecords.get(ev.id)).toMatchObject({ topicId: topic.id });
    await check();
    expect(await questions('open')).toHaveLength(0);
  });

  it('„Beides ist richtig“ ändert nichts und wird dauerhaft gemerkt', async () => {
    const { topic, project } = await seed();
    const q = await askedQuestion();

    const answered = await app.ok('insights:respond', { response: 'choose', id: q.id, choiceId: 'different', confirmed: true, strongConfirmed: false });

    expect(answered).toMatchObject({ status: 'rejected', chosenChoiceId: 'different' });
    expect(graph().getEntity(topic.id)).toBeDefined();
    expect(graph().getEntity(project.id)).toBeDefined();
    for (const c of q.choices.filter((x) => x.actionId)) expect(app.services.actions.get(c.actionId!).status).toBe('rejected');
    await check();
    await check();
    expect(await questions('open')).toHaveLength(0);
    expect(await questions()).toHaveLength(1);
  });

  it('lehnt ungültige Antworten ab und verlangt die Bestätigung', async () => {
    await seed();
    const q = await askedQuestion();

    const unconfirmed = await app.call('insights:respond', {
      response: 'choose',
      id: q.id,
      choiceId: 'project',
      confirmed: false as unknown as true,
      strongConfirmed: false,
    });
    const unknown = await app.call('insights:respond', { response: 'choose', id: q.id, choiceId: 'egal', confirmed: true, strongConfirmed: false });
    const plainAccept = await app.call('insights:respond', { response: 'accept', id: q.id, confirmed: true, strongConfirmed: false });

    expect(unconfirmed.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    expect(plainAccept.ok).toBe(false);
    expect((await questions('open')).map((i) => i.id)).toEqual([q.id]);

    await app.ok('insights:respond', { response: 'choose', id: q.id, choiceId: 'different', confirmed: true, strongConfirmed: false });
    const again = await app.call('insights:respond', { response: 'choose', id: q.id, choiceId: 'project', confirmed: true, strongConfirmed: false });
    expect(again.ok).toBe(false);
  });

  it('eine Frage, deren Paar es nicht mehr gibt, verschwindet', async () => {
    const { topic, project } = await seed();
    await askedQuestion();

    await graph().merge({ sourceIds: [topic.id], targetId: project.id, allowCrossType: true });
    await check();

    expect(await questions()).toHaveLength(0);
  });
});
