import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const persons = () => app.services.persons;
const graph = () => app.services.graph;
const personNames = () =>
  graph()
    .listEntities({ type: 'person' })
    .map((e) => e.name)
    .sort();

const decision = (title: string, participants: string[]) =>
  app.ok('decisions:create', {
    decisionText: title,
    title,
    decidedAt: '2026-09-01',
    participants,
    topic: 'Plattform',
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

async function archivedDoc(title: string, persons: string[]): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title, summary: 'Zusammenfassung', categoryPath: 'work/notes', persons }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${title}.txt`, `${title}: ausreichend langer Inhalt für den Test`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'index_only' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

describe('central person resolution (#28)', () => {
  it('resolves in the order exact name, alias, name without role/title', async () => {
    const monika = persons().resolve('Monika Lor-Zade');
    expect(monika).toMatchObject({ matchedBy: 'created', name: 'Monika Lor-Zade', rejected: false });

    for (const form of ['monika lor-zade', 'Monika Lor Zade'])
      expect(persons().resolve(form), form).toMatchObject({ matchedBy: 'exact', entity: { id: monika.entity!.id } });
    graph().addAlias(monika.entity!.id, 'Mo LZ');
    expect(persons().resolve('Mo LZ')).toMatchObject({ matchedBy: 'alias', entity: { id: monika.entity!.id } });
    for (const form of ['Monika Lor-Zade (chefin)', 'Monika Lor-Zade (Führungskraft)', 'Lor-Zade, Monika', 'Dr. Monika Lor-Zade', 'MONIKA LOR-ZADE, Chefin'])
      expect(persons().resolve(form), form).toMatchObject({ matchedBy: 'normalized', entity: { id: monika.entity!.id }, name: 'Monika Lor-Zade' });

    expect(personNames()).toEqual(['Monika Lor-Zade']);
    expect(graph().getEntity(monika.entity!.id)!.roles).toEqual(['Chefin', 'Führungskraft']);
  });

  it('stores roles of a new person and never as part of the name', () => {
    const r = persons().resolve('Monika Lor-Zade (chefin)');
    expect(r).toMatchObject({ matchedBy: 'created', name: 'Monika Lor-Zade', entity: { name: 'Monika Lor-Zade', roles: ['Chefin'] } });
    // known role (other case) is not added twice
    persons().resolve('Monika Lor-Zade – CHEFIN');
    expect(graph().getEntity(r.entity!.id)!.roles).toEqual(['Chefin']);
  });

  it('matches umlaut spellings of existing persons', () => {
    const j = persons().resolve('Jürgen Weiß').entity!;
    expect(persons().resolve('Juergen Weiss').entity!.id).toBe(j.id);
  });

  it('prefers the clean, oldest entity when legacy duplicates share a key', () => {
    const legacy = graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade (chefin)' });
    const clean = graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade' });
    expect(persons().resolve('Dr. Monika Lor-Zade').entity!.id).toBe(clean.id);
    expect(persons().resolve('Monika Lor-Zade (chefin)').entity!.id).toBe(legacy.id); // exact name wins
  });

  it('never creates pronouns or answer words as persons', async () => {
    for (const w of ['ich', 'ja', 'nein', 'unbekannt', 'keiner', 'mir']) {
      const r = persons().resolve(w);
      expect(r, w).toMatchObject({ entity: null, name: null, rejected: true });
    }
    expect(personNames()).toEqual([]);

    // manual creation is refused with a German message
    const res = await app.call('knowledge:createEntity', { type: 'person', name: 'ja' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('kein Personenname');
    // manual creation finds an existing person by another spelling and stores the role
    const first = await app.ok('knowledge:createEntity', { type: 'person', name: 'Monika Lor-Zade' });
    expect(first.created).toBe(true);
    const again = await app.ok('knowledge:createEntity', { type: 'person', name: 'Lor-Zade, Monika (Chefin)' });
    expect(again).toMatchObject({ created: false, entity: { id: first.entity.id, roles: ['Chefin'] } });
  });

  it('does not assign ambiguous short forms but reports the candidates', () => {
    const lz = persons().resolve('Monika Lor-Zade').entity!;
    const sm = persons().resolve('Monika Schmidt').entity!;
    const r = persons().resolve('Monika');
    expect(r.matchedBy).toBe('created');
    expect(r.entity!.id).not.toBe(lz.id);
    expect(r.entity!.id).not.toBe(sm.id);
    expect(r.ambiguousCandidates.map((c) => [c.entity.name, c.relation]).sort()).toEqual([
      ['Monika Lor-Zade', 'first_name_only'],
      ['Monika Schmidt', 'first_name_only'],
    ]);
    // the next mention finds the separate entity by its exact name
    expect(persons().resolve('Monika')).toMatchObject({ matchedBy: 'exact', entity: { id: r.entity!.id } });
  });

  it('an alias shared by two persons is ambiguous', () => {
    const a = persons().resolve('Monika Lor-Zade').entity!;
    const b = persons().resolve('Monika Schmidt').entity!;
    graph().addAlias(a.id, 'Moni');
    graph().addAlias(b.id, 'Moni');
    const r = persons().resolve('Moni', { create: false });
    expect(r.entity).toBeNull();
    expect(r.ambiguousCandidates.map((c) => c.entity.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.ambiguousCandidates.every((c) => c.relation === 'shared_alias')).toBe(true);
  });

  it('only looks up with create: false', () => {
    const r = persons().resolve('Monika Lor-Zade (Chefin)', { create: false });
    expect(r).toMatchObject({ entity: null, name: 'Monika Lor-Zade', matchedBy: null });
    expect(personNames()).toEqual([]);
  });

  it('consults the self resolver for self references and as the last step', () => {
    const me = graph().ensureEntity({ type: 'person', name: 'Matthias Beispiel' });
    const contexts: string[] = [];
    persons().setSelfResolver(({ parsed, selfReference, context }) => {
      contexts.push(`${parsed.cleanName}:${context}`);
      if (selfReference && context === 'chat') return me;
      return parsed.comparisonKey === 'matze' ? me : null;
    });
    expect(persons().resolve('ich', { context: 'chat' })).toMatchObject({ matchedBy: 'self', entity: { id: me.id } });
    expect(persons().resolve('ich', { context: 'document' })).toMatchObject({ entity: null, rejected: true });
    expect(persons().resolve('Matze')).toMatchObject({ matchedBy: 'self', entity: { id: me.id } });
    expect(persons().resolve('Matthias Beispiel')).toMatchObject({ matchedBy: 'exact' }); // earlier steps win
    expect(contexts).toEqual(['ich:chat', 'ich:document', 'Matze:manual']);
    persons().setSelfResolver(null);
    expect(persons().resolve('Matze').matchedBy).toBe('created');
  });

  it('resolves name lists to canonical names without duplicates', () => {
    persons().resolve('Monika Lor-Zade');
    const r = persons().resolveNames(['Lor-Zade, Monika', 'Monika Lor-Zade (chefin)', 'ja', 'ich', ' ', 'Anna Schmidt'], { context: 'decision' });
    expect(r.names).toEqual(['Monika Lor-Zade', 'ich', 'Anna Schmidt']);
    expect(r.entities.map((e) => e.name)).toEqual(['Monika Lor-Zade', 'Anna Schmidt']);
    // in documents "ich" is the author, not the user
    expect(persons().resolveNames(['ich', 'Anna Schmidt'], { context: 'document' }).names).toEqual(['Anna Schmidt']);
    // a person created by the list is found by later spellings in the same list
    const same = persons().resolveNames(['Peter Meier (CTO)', 'Meier, Peter']);
    expect(same.names).toEqual(['Peter Meier']);
    expect(graph().findByName('person', 'Peter Meier')!.roles).toEqual(['CTO']);
  });
});

describe('call sites use the central resolution (#28)', () => {
  it('decision participants: canonical names, one person, roles stored, no person from "ja"', async () => {
    await decision('Erste', ['Monika Lor-Zade (chefin)', 'ja']);
    const d2 = await decision('Zweite', ['Lor-Zade, Monika', 'Dr. Monika Lor-Zade', 'Monika Lor-Zade (Führungskraft)']);
    expect(d2.participants).toEqual(['Monika Lor-Zade']);
    expect(personNames()).toEqual(['Monika Lor-Zade']);
    const monika = graph().findByName('person', 'Monika Lor-Zade')!;
    expect(monika.roles).toEqual(['Chefin', 'Führungskraft']);
    expect(graph().relationsOf(monika.id, { types: ['participated_in'] })).toHaveLength(2);

    // updating re-syncs the graph without creating duplicates
    const updated = await app.ok('decisions:update', { id: d2.id, patch: { participants: ['Monika Lor-Zade (chefin)', 'Anna Schmidt'] } });
    expect(updated.participants).toEqual(['Monika Lor-Zade', 'Anna Schmidt']);
    expect(personNames()).toEqual(['Anna Schmidt', 'Monika Lor-Zade']);
  });

  it('a decision whose only participant is an answer word still misses participants', async () => {
    const d = await decision('Nur ja', ['ja']);
    expect(d.participants).toEqual([]);
    expect(d.missingFields).toContain('participants');
  });

  it('open items: responsible resolved; answer words neither create a person nor clear the responsible person', async () => {
    graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade' });
    const item = await app.ok('openItems:create', { title: 'Budget klären', responsible: 'Lor-Zade, Monika (Chefin)' });
    expect(item.responsibleName).toBe('Monika Lor-Zade');
    const after = await app.ok('openItems:update', { id: item.id, patch: { responsible: 'ja' } });
    expect(after.responsibleName).toBe('Monika Lor-Zade');
    const none = await app.ok('openItems:create', { title: 'Etwas anderes', responsible: 'unbekannt' });
    expect(none.responsibleName).toBeNull();
    expect(personNames()).toEqual(['Monika Lor-Zade']);
    expect(graph().findByName('person', 'Monika Lor-Zade')!.roles).toEqual(['Chefin']);
  });

  it('documents: persons stored and linked with canonical names', async () => {
    graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade' });
    const id = await archivedDoc('Protokoll', ['Dr. Monika Lor-Zade (Führungskraft)', 'ich', 'Anna Schmidt', 'Lor-Zade, Monika']);
    const doc = await app.ok('documents:get', { id });
    expect(doc.persons).toEqual(['Monika Lor-Zade', 'Anna Schmidt']);
    expect(personNames()).toEqual(['Anna Schmidt', 'Monika Lor-Zade']);
    const monika = graph().findByName('person', 'Monika Lor-Zade')!;
    expect(monika.roles).toEqual(['Führungskraft']);
    expect(
      graph()
        .neighbors(id, { types: ['person'] })
        .map((e) => e.name)
        .sort(),
    ).toEqual(['Anna Schmidt', 'Monika Lor-Zade']);

    const edited = await app.ok('documents:updateMetadata', { id, persons: ['Lor-Zade, Monika', 'nein', 'Neue Person'], confirmed: true });
    expect(edited.persons).toEqual(['Monika Lor-Zade', 'Neue Person']);
  });

  it('a merge collects the roles of the merged persons', async () => {
    const a = graph().ensureEntity({ type: 'person', name: 'Monika Lor-Zade' });
    const b = graph().ensureEntity({ type: 'person', name: 'Monika L.' });
    graph().addRoles(a.id, ['Chefin']);
    graph().addRoles(b.id, ['chefin', 'Führungskraft']);
    await graph().merge({ sourceIds: [b.id], targetId: a.id });
    expect(graph().getEntity(a.id)!.roles).toEqual(['Chefin', 'Führungskraft']);
  });
});
