import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestAppOptions } from '../helpers/harness';

let app: TestApp;
async function start(opts: TestAppOptions = { privacy: 'auto' }) {
  app = await createTestApp(opts);
  app.llm.on('PersonHints', () => ({ questions: [] }));
}
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const person = (name: string) => graph().ensureEntity({ type: 'person', name });
const questions = (status: 'open' | 'rejected' | 'accepted' = 'open') => app.services.insights.list(status).filter((i) => i.kind === 'unclear_person');
const choose = (id: string, choiceId: string) => app.ok('insights:respond', { response: 'choose', id, choiceId, confirmed: true, strongConfirmed: false });
const hintCalls = () => app.llm.calls.filter((c) => c.schema === 'PersonHints');

describe('Asking about unclear person assignments (#27)', () => {
  it.each([
    ['Monika', 'Monika Lor-Zade', /nur der Vorname/],
    ['Lor-Zade', 'Monika Lor-Zade', /nur der Nachname/],
    ['M. Lor-Zade', 'Monika Lor-Zade', /Initiale/],
    ['Anna Schmidt', 'Anna Maria Schmidt', /zweiten Vornamen/],
    ['Monika Lorzadeh', 'Monika Lor-Zade', /ähnlich geschrieben/],
  ])('asks about „%s“ ↔ „%s“ instead of guessing', async (a, b, reason) => {
    await start();
    // the complete name is known first, the unclear mention comes later
    person(b);
    person(a);
    await app.services.consistency.run('manual');
    const [q] = questions();
    expect(q).toBeDefined();
    expect(q!.title).toBe(`Ist „${a}“ dieselbe Person wie „${b}“?`);
    expect(q!.explanation).toMatch(reason);
    expect(q!.choices.map((c) => c.label)).toEqual(['Gleich', 'Verschieden']);
    expect(graph().listEntities({ type: 'person' })).toHaveLength(2);
  });

  it('shows evidence: shared decisions and topics', async () => {
    await start();
    const monika = person('Monika');
    const full = person('Monika Lor-Zade');
    const topic = graph().ensureEntity({ type: 'topic', name: 'Budget 2027' });
    const dec = await app.ok('decisions:create', {
      decisionText: 'Budget freigegeben',
      title: 'Budget freigegeben',
      decidedAt: '2026-09-01',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    for (const p of [monika, full]) {
      graph().link({ sourceId: p.id, targetId: dec.id, relationType: 'participated_in' }, { status: 'confirmed' });
      graph().link({ sourceId: p.id, targetId: topic.id, relationType: 'relates_to' }, { status: 'confirmed' });
    }
    await app.services.consistency.run('manual');
    const [q] = questions();
    expect(q!.explanation).toContain('Gemeinsam: 1 gemeinsame Entscheidung, gemeinsame Themen/Projekte: „Budget 2027“');
    expect(q!.explanation).toContain('• „Monika“: 0 Dokumente, 1 Entscheidung, Themen/Projekte: Budget 2027');
  });

  it('„Gleich“ merges, remembers the spelling as an alias and can be undone', async () => {
    await start();
    const short = person('M. Lor-Zade');
    const full = person('Monika Lor-Zade');
    await app.services.consistency.run('manual');
    const [q] = questions();
    await choose(q!.id, 'same');

    expect(graph().getEntity(short.id)).toBeUndefined();
    expect(graph().getEntity(full.id)!.aliases).toContain('M. Lor-Zade');
    expect(graph().findByNameOrAlias('person', 'M. Lor-Zade')?.id).toBe(full.id);

    const merge = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((e) => e.action === 'entity.merge')!;
    expect((await app.ok('audit:undo', { auditId: merge.id })).undone).toBe(true);
    expect(graph().getEntity(short.id)).toBeDefined();
  });

  it('„Verschieden“ is remembered permanently – also after a rename', async () => {
    await start();
    const short = person('Monika');
    const full = person('Monika Lor-Zade');
    await app.services.consistency.run('manual');
    await choose(questions()[0]!.id, 'different');
    expect(questions()).toHaveLength(0);

    await app.services.consistency.run('manual');
    expect(questions()).toHaveLength(0);

    // renamed so that the names no longer look alike, then back: never asked again
    app.services.database.sqlite.prepare("UPDATE entities SET name = 'Moni', normalized_name = 'moni' WHERE id = ?").run(short.id);
    await app.services.consistency.run('manual');
    app.services.database.sqlite.prepare("UPDATE entities SET name = 'Monika', normalized_name = 'monika' WHERE id = ?").run(short.id);
    await app.services.consistency.run('manual');
    expect(questions()).toHaveLength(0);
    expect(questions('rejected').some((q) => q.sourceIds.includes(short.id) && q.sourceIds.includes(full.id))).toBe(true);
  });

  it('with several candidates asks one question „Welche … ist gemeint?“ with „Keine davon“', async () => {
    await start();
    const short = person('Monika');
    const a = person('Monika Lor-Zade');
    const b = person('Monika Schmidt');
    await app.services.consistency.run('manual');
    const qs = questions();
    expect(qs).toHaveLength(1);
    expect(qs[0]!.title).toBe('Welche Monika ist gemeint?');
    expect(qs[0]!.choices.map((c) => c.label)).toEqual(['Monika Lor-Zade', 'Monika Schmidt', 'Keine davon']);

    await choose(qs[0]!.id, b.id);
    expect(graph().getEntity(short.id)).toBeUndefined();
    expect(graph().getEntity(b.id)!.aliases).toContain('Monika');
    expect(graph().getEntity(a.id)).toBeDefined();
  });

  it('„Keine davon“ is remembered per candidate', async () => {
    await start();
    person('Monika');
    person('Monika Lor-Zade');
    person('Monika Schmidt');
    await app.services.consistency.run('manual');
    await choose(questions()[0]!.id, 'none');
    await app.services.consistency.run('manual');
    await app.services.consistency.run('manual');
    expect(questions()).toHaveLength(0);
    // a new candidate is asked about on its own
    person('Monika Weber');
    await app.services.consistency.run('manual');
    expect(questions().map((q) => q.title)).toEqual(['Ist „Monika“ dieselbe Person wie „Monika Weber“?']);
  });

  it('withdraws questions that no longer apply – along with their proposals', async () => {
    await start();
    const short = person('Monika');
    const full = person('Monika Lor-Zade');
    const other = person('Monika L.');
    await app.services.consistency.run('manual');
    const pending = app.services.actions.list('proposed').filter((a) => a.actionType === 'merge_entities');
    expect(pending.length).toBeGreaterThan(0);

    await graph().merge({ sourceIds: [short.id], targetId: full.id });
    await app.services.consistency.run('manual');
    for (const a of pending) expect(app.services.actions.get(a.id).status).toBe('withdrawn');
    expect(questions().every((q) => !q.sourceIds.includes(short.id))).toBe(true);
    expect(graph().getEntity(other.id)).toBeDefined();
  });

  it('in mode „automatisch“ obtains an LLM hint (names only) that decides nothing', async () => {
    await start({ privacy: 'auto' });
    app.llm.on('PersonHints', () => ({ questions: [{ nr: 1, verdict: 'same', reason: 'Initiale passt zum Vornamen.' }] }));
    person('M. Lor-Zade');
    person('Monika Lor-Zade');
    await app.services.consistency.run('manual');
    expect(hintCalls()).toHaveLength(1);
    expect(hintCalls()[0]!.input).toBe('1. „M. Lor-Zade“ / „Monika Lor-Zade“');
    const [q] = questions();
    expect(q!.explanation).toContain('Hinweis des Sprachmodells: wahrscheinlich dieselbe Person – Initiale passt zum Vornamen.');
    expect(graph().listEntities({ type: 'person' })).toHaveLength(2);

    // known questions are not sent again, the hint stays
    await app.services.consistency.run('manual');
    expect(hintCalls()).toHaveLength(1);
    expect(questions()[0]!.explanation).toContain('Hinweis des Sprachmodells');
  });

  it.each(['confirm', 'local_only'] as const)('sends nothing to the LLM in privacy mode %s', async (privacy) => {
    await start({ privacy });
    person('M. Lor-Zade');
    person('Monika Lor-Zade');
    await app.services.consistency.run('manual');
    expect(hintCalls()).toHaveLength(0);
    expect(questions()).toHaveLength(1);
  });
});
