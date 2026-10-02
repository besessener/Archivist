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

describe('Eigene Identität (#29)', () => {
  it('legt genau eine eigene Person an – ohne Namen als Platzhalter „Ich“', () => {
    const me = self().ensure();
    expect(me).toMatchObject({ name: 'Ich', isSelf: true, type: 'person' });
    expect(self().ensure().id).toBe(me.id);
    expect(selves()).toHaveLength(1);
  });

  it('benennt den Platzhalter um, sobald der Name eingetragen ist (rückgängig machbar)', async () => {
    const me = self().ensure();
    setName('Monika Lor-Zade', ['Moni']);
    await waitFor(() => graph().getEntity(me.id)!.name === 'Monika Lor-Zade');
    expect(graph().getEntity(me.id)).toMatchObject({ isSelf: true, aliases: [] });

    const rename = (await app.ok('audit:list', { limit: 10, onlyUndoable: true })).find((e) => e.action === 'entity.rename')!;
    expect((await app.ok('audit:undo', { auditId: rename.id })).undone).toBe(true);
    expect(graph().getEntity(me.id)!.name).toBe('Ich');
  });

  it('führt eine vorhandene Person mit dem eingetragenen Namen mit der eigenen Person zusammen', async () => {
    const me = self().ensure();
    const existing = graph().ensureEntity('person', 'Monika Lor-Zade');
    const topic = graph().ensureEntity('topic', 'Budget');
    graph().link(existing.id, topic.id, 'relates_to', { status: 'confirmed' });

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

  it('nimmt beim ersten Anlegen eine Person, die schon so heißt, statt eine zweite anzulegen', () => {
    const existing = graph().ensureEntity('person', 'Dr. Monika Lor-Zade');
    setName('Monika Lor-Zade');
    expect(self().ensure().id).toBe(existing.id);
  });

  it('im Chat meinen „ich/mir/mich/mein …“ die eigene Person, in Dokumenten nicht', () => {
    setName('Monika Lor-Zade');
    const me = self().ensure();
    for (const w of ['ich', 'mir', 'mich', 'mein']) expect(app.services.persons.resolve(w, { context: 'chat' }).entity?.id).toBe(me.id);
    expect(app.services.persons.resolveNames(['ich', 'Anna'], { context: 'chat' }).names).toEqual(['Monika Lor-Zade', 'Anna']);
    // in documents „ich“ is the author
    expect(app.services.persons.resolve('ich', { context: 'document' }).entity).toBeNull();
    expect(app.services.persons.resolveNames(['ich', 'Monika Lor-Zade'], { context: 'document' }).entities.map((e) => e.id)).toEqual([me.id]);
  });

  it('ordnet Spitznamen und andere Schreibweisen des eigenen Namens der eigenen Person zu', () => {
    setName('Monika Lor-Zade', ['Moni']);
    const me = self().ensure();
    expect(app.services.persons.resolve('Moni', { context: 'document' }).entity?.id).toBe(me.id);
    expect(app.services.persons.resolve('Lor-Zade, Monika', { context: 'decision' }).entity?.id).toBe(me.id);
  });

  it('Chat: „Verantwortlich: ich“ wird die eigene Person', async () => {
    setName('Monika Lor-Zade');
    app.llm.on('ChatIntent', () => ({ intent: 'open_item_new', confidence: 0.9, rationale: 't', openItem: { title: 'Angebot prüfen', responsible: 'ich' } }));
    const r = await app.ok('chat:send', { text: 'Ich muss das Angebot prüfen.' });
    const [item] = await app.ok('openItems:list', {});
    expect(item!.responsibleName).toBe('Monika Lor-Zade');
    expect(graph().getEntity(item!.responsiblePersonId!)!.isSelf).toBe(true);
    expect(r.assistantMessage.content).toContain('Verantwortlich: du');
    expect(app.llm.calls.find((c) => c.schema === 'ChatIntent')!.input).toContain('Der Benutzer heißt Monika Lor-Zade');
  });

  it('die Archivprüfung führt Personen mit meinem Namen, Spitznamen oder „ich“ mit mir zusammen', async () => {
    setName('Monika Lor-Zade', ['Moni']);
    const me = self().ensure();
    const ich = graph().ensureEntity('person', 'ich'); // former entry from before the own identity existed
    const moni = graph().ensureEntity('person', 'Moni');
    const role = graph().ensureEntity('person', 'Monika Lor-Zade (Chefin)');
    const other = graph().ensureEntity('person', 'Anna Schmidt');

    await app.services.consistency.run('manual');

    for (const e of [ich, moni, role]) expect(graph().getEntity(e.id)).toBeUndefined();
    expect(graph().getEntity(other.id)).toBeDefined();
    expect(graph().getEntity(me.id)).toMatchObject({ name: 'Monika Lor-Zade', isSelf: true, roles: ['Chefin'] });
    expect(graph().getEntity(me.id)!.aliases).toEqual(expect.arrayContaining(['ich', 'Moni', 'Monika Lor-Zade (Chefin)']));
    const insight = app.services.insights.list('open').find((i) => i.kind === 'persons_merged')!;
    expect(insight.title).toBe('4 Einträge zu „Monika Lor-Zade“ zusammengeführt');
    expect(selves()).toHaveLength(1);
  });
});
