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

const graph = () => app.services.graph;
const sqlite = () => app.services.database.sqlite;
const persons = () => graph().listEntities({ type: 'person', limit: 1000 });

/** Every table an automatic merge touches (compared before the merge and after its undo). */
function state() {
  const all = (q: string) => sqlite().prepare(q).all();
  return {
    entities: all("SELECT * FROM entities WHERE type = 'person' ORDER BY id"),
    relations: all('SELECT * FROM relations ORDER BY id'),
    documents: all('SELECT id, persons, updated_at FROM documents ORDER BY id'),
    decisions: all('SELECT id, participants, updated_at FROM decisions ORDER BY id'),
    openItems: all('SELECT id, responsible_person_id, updated_at FROM open_items ORDER BY id'),
  };
}

async function importedDoc(title: string): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title, summary: 'Zusammenfassung', categoryPath: 'work/notes' }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${title}.txt`, `${title}: ausreichend langer Inhalt für den Test`)] });
  await app.services.jobs.whenIdle();
  return imp.imported[0]!.id;
}

/** The six spellings of the same person from the story, plus „Monika“ (unclear) and „ich“ (never a person). */
async function monikaArchive() {
  const spellings = ['Monika Lor-Zade', 'Monika Lor-Zade (chefin)', 'Monika Lor-Zade (Führungskraft)', 'Lor-Zade, Monika', 'Dr. Monika Lor-Zade'];
  // legacy data: the entries were created before mentions were resolved centrally
  const ids = Object.fromEntries(spellings.map((n) => [n, graph().ensureEntity({ type: 'person', name: n }).id]));
  const monika = graph().ensureEntity({ type: 'person', name: 'Monika' });
  const ich = graph().ensureEntity({ type: 'person', name: 'ich' });
  const dec = await app.ok('decisions:create', {
    decisionText: 'Wir verschieben den Launch.',
    title: 'Launch verschoben',
    decidedAt: '2026-09-01',
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });
  sqlite()
    .prepare('UPDATE decisions SET participants = ? WHERE id = ?')
    .run(JSON.stringify(['Monika Lor-Zade (chefin)', 'Lor-Zade, Monika', 'Anna']), dec.id);
  graph().link({ sourceId: ids['Lor-Zade, Monika']!, targetId: dec.id, relationType: 'participated_in' }, { status: 'confirmed', confidence: 0.9 });
  const item = await app.ok('openItems:create', { title: 'Budget klären', priority: 'normal', sourceIds: [], confidence: 0.9 });
  sqlite().prepare('UPDATE open_items SET responsible_person_id = ? WHERE id = ?').run(ids['Dr. Monika Lor-Zade'], item.id);
  const doc = await importedDoc('Protokoll');
  sqlite()
    .prepare('UPDATE documents SET persons = ? WHERE id = ?')
    .run(JSON.stringify(['Monika Lor-Zade (Führungskraft)']), doc);
  return { ids, monika, ich, dec, item, doc };
}

describe('Automatically merging person duplicates (#26)', () => {
  it('merges the unambiguous spellings into one person, stores roles and re-links all references', async () => {
    const { ids, monika, ich, dec, item, doc } = await monikaArchive();
    expect(persons()).toHaveLength(7 + 1); // + „Anna“

    const report = await app.services.consistency.run({ trigger: 'manual' });

    const target = graph().getEntity(ids['Monika Lor-Zade']!)!;
    expect(target.name).toBe('Monika Lor-Zade');
    expect(target.roles).toEqual(['Chefin', 'Führungskraft']);
    expect(target.aliases).toEqual(
      expect.arrayContaining(['Monika Lor-Zade (chefin)', 'Monika Lor-Zade (Führungskraft)', 'Lor-Zade, Monika', 'Dr. Monika Lor-Zade']),
    );
    // „Monika“ alone is unclear (asked separately), „ich“ is never merged here
    expect(
      persons()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['Anna', 'Monika', 'Monika Lor-Zade', 'ich']);
    expect(graph().getEntity(monika.id)).toBeDefined();
    expect(graph().getEntity(ich.id)).toBeDefined();

    expect(app.services.decisions.get(dec.id).participants).toEqual(['Monika Lor-Zade', 'Anna']);
    expect(app.services.openItems.get(item.id).responsiblePersonId).toBe(target.id);
    expect(app.services.documents.get(doc).persons).toEqual(['Monika Lor-Zade']);
    expect(
      graph()
        .relationsOf(dec.id)
        .some((r) => r.sourceEntityId === target.id && r.relationType === 'participated_in'),
    ).toBe(true);

    const insight = app.services.insights.list({ status: 'open' }).find((i) => i.kind === 'persons_merged')!;
    expect(insight.title).toBe('5 Einträge zu „Monika Lor-Zade“ zusammengeführt');
    expect(insight.recommendedActionLabel).toBe('Rückgängig');
    expect(report.byKind.persons_merged).toBe(5);
  });

  it('„Rückgängig“ restores the 4 merged entries exactly and does not merge them again afterwards', async () => {
    const { ids } = await monikaArchive();
    const before = state();
    await app.services.consistency.run({ trigger: 'manual' });
    expect(state()).not.toEqual(before);

    const insight = app.services.insights.list({ status: 'open' }).find((i) => i.kind === 'persons_merged')!;
    await app.ok('insights:respond', { response: 'accept', id: insight.id, confirmed: true, strongConfirmed: false });

    expect(state()).toEqual(before);
    const restored = Object.values(ids).filter((id) => id !== ids['Monika Lor-Zade']);
    expect(restored).toHaveLength(4);
    for (const id of restored) expect(graph().getEntity(id)).toBeDefined();

    await app.services.consistency.run({ trigger: 'manual' });
    expect(state()).toEqual(before);
    expect(app.services.insights.list({ status: 'open' }).filter((i) => i.kind === 'persons_merged')).toHaveLength(0);
  });

  it('„Behalten“ keeps the merge; later runs find nothing more', async () => {
    await monikaArchive();
    await app.services.consistency.run({ trigger: 'manual' });
    const insight = app.services.insights.list({ status: 'open' }).find((i) => i.kind === 'persons_merged')!;
    await app.ok('insights:respond', { response: 'reject', id: insight.id });

    const again = await app.services.consistency.run({ trigger: 'manual' });
    expect(again.byKind.persons_merged).toBeUndefined();
    expect(
      persons()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['Anna', 'Monika', 'Monika Lor-Zade', 'ich']);
  });

  it('picks the cleanest spelling as the name, even when no entry carries it', async () => {
    const a = graph().ensureEntity({ type: 'person', name: 'monika lor zade (chefin)' });
    const b = graph().ensureEntity({ type: 'person', name: 'Lor-Zade, Monika' });
    await app.services.consistency.run({ trigger: 'manual' });
    const left = persons();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ name: 'Monika Lor-Zade', roles: ['Chefin'] });
    expect([a.id, b.id]).toContain(left[0]!.id);
  });

  it('can be switched off', async () => {
    await monikaArchive();
    app.services.settings.update({ consistency: { autoMergePersons: false } });
    const report = await app.services.consistency.run({ trigger: 'manual' });
    expect(report.byKind.persons_merged).toBeUndefined();
    expect(persons()).toHaveLength(8);
  });
});
