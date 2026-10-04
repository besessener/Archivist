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
const self = () => app.services.self;
const selves = () =>
  graph()
    .listEntities({ type: 'person', limit: 1000 })
    .filter((p) => p.isSelf);

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
}

const setName = (name: string, nicknames: string[] = []) => app.services.settings.update({ profile: { name, nicknames } });

describe('Own identity (#29)', () => {
  it('creates exactly one own person – without a name as the placeholder „Ich“', () => {
    const me = self().ensure();
    expect(me).toMatchObject({ name: 'Ich', isSelf: true, type: 'person' });
    expect(self().ensure().id).toBe(me.id);
    expect(selves()).toHaveLength(1);
  });

  it('renames the placeholder as soon as the name is entered (undoable)', async () => {
    const me = self().ensure();
    setName('Monika Lor-Zade', ['Moni']);
    await waitFor(() => graph().getEntity(me.id)!.name === 'Monika Lor-Zade');
    expect(graph().getEntity(me.id)).toMatchObject({ isSelf: true, aliases: [] });

    const rename = (await app.ok('audit:list', { limit: 10, onlyUndoable: true })).find((e) => e.action === 'entity.rename')!;
    expect((await app.ok('audit:undo', { auditId: rename.id })).undone).toBe(true);
    expect(graph().getEntity(me.id)!.name).toBe('Ich');
  });

  it('merges an existing person with the entered name into the own person', async () => {
    const me = self().ensure();
    const existing = graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade' });
    const topic = graph().ensureEntity({ type: 'topic', name: 'Budget' });
    graph().link({ sourceId: existing.id, targetId: topic.id, relationType: 'relates_to' }, { status: 'confirmed' });

    setName('Monika Lor-Zade');
    await waitFor(() => !graph().getEntity(existing.id));
    expect(graph().getEntity(me.id)).toMatchObject({ name: 'Monika Lor-Zade', isSelf: true });
    expect(
      graph()
        .neighbors(me.id)
        .map((n) => n.id),
    ).toContain(topic.id);
    expect(selves()).toHaveLength(1);
  });

  it('on first creation takes a person who already has that name instead of creating a second one', () => {
    const existing = graph().ensureEntity({ type: 'person', name: 'Dr. Monika Lor-Zade' });
    setName('Monika Lor-Zade');
    expect(self().ensure().id).toBe(existing.id);
  });

  it('in the chat „ich/mir/mich/mein …“ means the own person, in documents not', () => {
    setName('Monika Lor-Zade');
    const me = self().ensure();
    for (const w of ['ich', 'mir', 'mich', 'mein']) expect(app.services.persons.resolve(w, { context: 'chat' }).entity?.id).toBe(me.id);
    expect(app.services.persons.resolveNames(['ich', 'Anna'], { context: 'chat' }).names).toEqual(['Monika Lor-Zade', 'Anna']);
    // in documents „ich“ is the author
    expect(app.services.persons.resolve('ich', { context: 'document' }).entity).toBeNull();
    expect(app.services.persons.resolveNames(['ich', 'Monika Lor-Zade'], { context: 'document' }).entities.map((e) => e.id)).toEqual([me.id]);
  });

  it('assigns nicknames and other spellings of the own name to the own person', () => {
    setName('Monika Lor-Zade', ['Moni']);
    const me = self().ensure();
    expect(app.services.persons.resolve('Moni', { context: 'document' }).entity?.id).toBe(me.id);
    expect(app.services.persons.resolve('Lor-Zade, Monika', { context: 'decision' }).entity?.id).toBe(me.id);
  });

  it('chat: „Verantwortlich: ich“ becomes the own person', async () => {
    setName('Monika Lor-Zade');
    app.llm.on('ChatIntent', () => ({ intent: 'open_item_new', confidence: 0.9, rationale: 't', openItem: { title: 'Angebot prüfen', responsible: 'ich' } }));
    const r = await app.ok('chat:send', { text: 'Ich muss das Angebot prüfen.' });
    const [item] = await app.ok('openItems:list', {});
    expect(item!.responsibleName).toBe('Monika Lor-Zade');
    expect(graph().getEntity(item!.responsiblePersonId!)!.isSelf).toBe(true);
    expect(r.assistantMessage.content).toContain('Verantwortlich: du');
    expect(app.llm.calls.find((c) => c.schema === 'ChatIntent')!.input).toContain('Der Benutzer heißt Monika Lor-Zade');
  });

  it('the archive check merges persons with my name, nickname or „ich“ into me', async () => {
    setName('Monika Lor-Zade', ['Moni']);
    const me = self().ensure();
    const ich = graph().ensureEntity({ type: 'person', name: 'ich' }); // former entry from before the own identity existed
    const moni = graph().ensureEntity({ type: 'person', name: 'Moni' });
    const role = graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade (Chefin)' });
    const other = graph().ensureEntity({ type: 'person', name: 'Anna Schmidt' });

    await app.services.consistency.run({ trigger: 'manual' });

    for (const e of [ich, moni, role]) expect(graph().getEntity(e.id)).toBeUndefined();
    expect(graph().getEntity(other.id)).toBeDefined();
    expect(graph().getEntity(me.id)).toMatchObject({ name: 'Monika Lor-Zade', isSelf: true, roles: ['Chefin'] });
    expect(graph().getEntity(me.id)!.aliases).toEqual(expect.arrayContaining(['ich', 'Moni', 'Monika Lor-Zade (Chefin)']));
    const insight = app.services.insights.list({ status: 'open' }).find((i) => i.kind === 'persons_merged')!;
    expect(insight.title).toBe('4 Einträge zu „Monika Lor-Zade“ zusammengeführt');
    expect(selves()).toHaveLength(1);
  });
});
