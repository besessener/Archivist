import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestAppOptions } from '../helpers/harness';

let app: TestApp;
async function start(opts: TestAppOptions = { privacy: 'auto' }) {
  app = await createTestApp(opts);
}
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const sqlite = () => app.services.database.sqlite;
const check = () => app.services.consistency.run({ trigger: 'test' });
const duplicates = (status?: 'open' | 'accepted' | 'rejected' | 'snoozed') =>
  app.services.insights.list({ status }).filter((i) => i.kind === 'similar_entities');
const forPair = (a: string, b: string) => duplicates().filter((i) => [a, b].every((id) => i.sourceIds.includes(id)));
const hintCalls = () => app.llm.calls.filter((c) => c.schema === 'DuplicateHints');

/** Full snapshot of every table a merge may touch (compared before the merge and after its undo). */
function state() {
  const all = (q: string) => sqlite().prepare(q).all();
  return {
    entities: all('SELECT * FROM entities ORDER BY id'),
    relations: all('SELECT * FROM relations ORDER BY id'),
    decisions: all('SELECT id, topic_id, project_id, participants, updated_at FROM decisions ORDER BY id'),
    openItems: all('SELECT id, topic_id, project_id, responsible_person_id, updated_at FROM open_items ORDER BY id'),
    events: all('SELECT id, topic_id, project_id, updated_at FROM events ORDER BY id'),
  };
}

const event = (title: string, extra: { topic?: string; project?: string }) =>
  app.ok('events:create', { title, occurredAt: '2026-09-04', sourceIds: [], ...extra });

describe('duplicate detection for topics, projects and tags (#30)', () => {
  it('asks about spelling variants, plurals, typos and prefix cases of the same type', async () => {
    await start();
    const g = graph();
    const pairs = [
      [g.ensureEntity({ type: 'topic', name: 'prod-plat' }), g.ensureEntity({ type: 'topic', name: 'ProdPlat' })],
      [g.ensureEntity({ type: 'project', name: 'Rechnung' }), g.ensureEntity({ type: 'project', name: 'Rechnungen' })],
      [g.ensureEntity({ type: 'tag', name: 'Steuererklärung' }), g.ensureEntity({ type: 'tag', name: 'Steuererklärnug' })],
      [g.ensureEntity({ type: 'topic', name: 'Urlaub' }), g.ensureEntity({ type: 'topic', name: 'Urlaub 2026' })],
    ];
    g.ensureEntity({ type: 'topic', name: 'Hauskauf' });

    const report = await check();

    expect(report.byKind.similar_entities).toBe(4);
    expect(duplicates('open')).toHaveLength(4);
    for (const [a, b] of pairs.slice(0, 3)) {
      const [insight] = forPair(a!.id, b!.id);
      expect(insight).toBeDefined();
      const action = app.services.actions.get(insight!.recommendedActionId!);
      expect(action.actionType).toBe('merge_entities');
      expect(action.status).toBe('proposed');
      expect(action.proposedParameters).toMatchObject({ allowCrossType: false });
    }
    const [prefix] = forPair(pairs[3]![0]!.id, pairs[3]![1]!.id);
    expect(prefix!.title).toBe('Gehört „Urlaub 2026“ zu „Urlaub“? (Themen)');
    expect(prefix!.confidence).toBeLessThan(0.5);
    // a prefix case of topics and projects also offers „Unterthema“ (#282)
    expect(prefix!.choices.map((c) => c.label)).toEqual(['Unterthema', 'Zusammenführen', 'Verschieden']);
    expect(app.services.actions.get(prefix!.choices[0]!.actionId!)).toMatchObject({
      actionType: 'link_entities',
      proposedParameters: { sourceId: pairs[3]![1]!.id, targetId: pairs[3]![0]!.id, relationType: 'subtopic_of' },
    });
    expect(app.services.actions.get(prefix!.choices[1]!.actionId!).actionType).toBe('merge_entities');
    const [typo] = forPair(pairs[2]![0]!.id, pairs[2]![1]!.id);
    expect(typo!.title).toContain('Tag');
    expect(typo!.explanation).toContain('Tippfehler');
    // nothing is merged on its own
    for (const [a, b] of pairs) expect([g.getEntity(a!.id), g.getEntity(b!.id)].every(Boolean)).toBe(true);
  });

  it('leaves topic/project pairs of the same name to the cross-type check', async () => {
    await start();
    graph().ensureEntity({ type: 'topic', name: 'prod-plat' });
    graph().ensureEntity({ type: 'project', name: 'Prod Plat' });
    await check();
    expect(duplicates()).toHaveLength(0);
  });

  it('shows the evidence and proposes the entity with more references as target', async () => {
    await start();
    await event('Planungstreffen', { topic: 'Urlaube' });
    await event('Buchung', { topic: 'Urlaube' });
    await app.ok('decisions:create', {
      decisionText: 'Wir fahren an die See.',
      title: 'Ziel',
      decidedAt: '2026-09-01',
      participants: ['Anna'],
      topic: 'Urlaube',
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
    });
    await app.ok('openItems:create', { title: 'Hotel buchen', topic: 'urlaub', sourceIds: [] });
    const many = graph().findByName('topic', 'Urlaube')!;
    const few = graph().findByName('topic', 'urlaub')!;

    await check();

    const [insight] = forPair(many.id, few.id);
    expect(insight!.explanation).toContain('Singular und Plural');
    expect(insight!.explanation).toContain('• Thema „Urlaube“: 1 Entscheidung, 2 Ereignisse');
    expect(insight!.explanation).toContain('• Thema „urlaub“: 1 offener Punkt');
    expect(insight!.explanation).toContain('(mehr Verweise)');
    expect(insight!.affected.map((e) => e.detail)).toEqual(['1 Entscheidung, 2 Ereignisse', '1 offener Punkt']);
    expect(app.services.actions.get(insight!.recommendedActionId!).proposedParameters).toMatchObject({ sourceIds: [few.id], targetId: many.id });
  });

  it('prefers the cleaner name when both are referenced equally often', async () => {
    await start();
    const lower = graph().ensureEntity({ type: 'topic', name: 'mueller umzug' });
    const clean = graph().ensureEntity({ type: 'topic', name: 'Müller Umzug' });
    await check();
    const [insight] = forPair(lower.id, clean.id);
    expect(app.services.actions.get(insight!.recommendedActionId!).proposedParameters).toMatchObject({ sourceIds: [lower.id], targetId: clean.id });
    expect(insight!.explanation).toContain('(klarerer Name)');
  });

  it('counts tagged documents as evidence for tags', async () => {
    await start();
    const tag = graph().ensureEntity({ type: 'tag', name: 'Rechnungen' });
    const other = graph().ensureEntity({ type: 'tag', name: 'Rechnung' });
    const now = new Date().toISOString();
    const insert = sqlite().prepare(
      `INSERT INTO documents (id, title, original_name, ext, mime, size, sha256, status, tags, created_at, updated_at) VALUES (?, ?, ?, 'txt', 'text/plain', 1, ?, 'archived', ?, ?, ?)`,
    );
    for (const n of [1, 2]) insert.run(`doc-${n}`, `Beleg ${n}`, `b${n}.txt`, `sha${n}`, JSON.stringify(['rechnungen']), now, now);
    await check();
    const [insight] = forPair(tag.id, other.id);
    expect(insight!.explanation).toContain('• Tag „Rechnungen“: 2 Dokumente');
    expect(insight!.explanation).toContain('• Tag „Rechnung“: keine Verweise');
  });

  it('creates no duplicate insights and retires the former topic-only check', async () => {
    await start();
    const a = graph().ensureEntity({ type: 'topic', name: 'Marketing' });
    const b = graph().ensureEntity({ type: 'topic', name: 'Marketings' });
    // a pending question of the former check (merge_topics, key similar-topics:)
    const legacyAction = app.services.actions.propose({
      actionType: 'merge_topics',
      label: 'alt',
      rationale: 'alt',
      confidence: 0.9,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { sourceTopicId: b.id, targetTopicId: a.id },
    });
    app.services.insights.upsert({
      kind: 'similar_topics',
      title: 'Ähnliche Themen',
      explanation: 'alt',
      confidence: 0.9,
      recommendedActionId: legacyAction.id,
      dedupeKey: `similar-topics:${[a.id, b.id].sort().join('|')}`,
    });

    const first = await check();
    const second = await check();

    expect(first.byKind.similar_entities).toBe(1);
    expect(second.byKind.similar_entities).toBe(1);
    expect(app.services.insights.list().filter((i) => i.kind === 'similar_topics')).toHaveLength(0);
    expect(app.services.actions.get(legacyAction.id).status).toBe('withdrawn');
    expect(forPair(a.id, b.id)).toHaveLength(1);
    // the proposal is reused, not proposed again on every run
    expect(app.services.actions.list().filter((x) => x.actionType === 'merge_entities')).toHaveLength(1);
  });

  it('remembers „Verschieden“ permanently, also after a rename', async () => {
    await start();
    const a = graph().ensureEntity({ type: 'project', name: 'Hauskauf' });
    const b = graph().ensureEntity({ type: 'project', name: 'Hauskauf Finanzierung' });
    await check();
    const [insight] = forPair(a.id, b.id);
    await app.ok('insights:respond', { response: 'choose', id: insight!.id, choiceId: 'different', confirmed: true });
    expect(forPair(a.id, b.id).map((i) => i.status)).toEqual(['rejected']);

    await check();
    sqlite().prepare("UPDATE entities SET name = 'Hauskauf Kredit', normalized_name = 'hauskauf kredit' WHERE id = ?").run(b.id);
    const after = await check();

    expect(after.byKind.similar_entities).toBeUndefined();
    expect(forPair(a.id, b.id).map((i) => i.status)).toEqual(['rejected']);
  });

  it('respects a rejection of the former topic-only check', async () => {
    await start();
    const a = graph().ensureEntity({ type: 'topic', name: 'Budget' });
    const b = graph().ensureEntity({ type: 'topic', name: 'Budgets' });
    const legacy = app.services.insights.upsert({
      kind: 'similar_topics',
      title: 'Ähnliche Themen',
      explanation: 'alt',
      confidence: 0.9,
      dedupeKey: `similar-topics:${[a.id, b.id].sort().join('|')}`,
    });
    await app.services.insights.reject(legacy.id);
    await check();
    await check();
    expect(forPair(a.id, b.id).map((i) => i.status)).toEqual(['rejected']);
    expect(app.services.actions.list().filter((x) => x.actionType === 'merge_entities')).toHaveLength(0);
  });

  it('withdraws a question whose entities no longer exist', async () => {
    await start();
    const a = graph().ensureEntity({ type: 'topic', name: 'Infrastruktur' });
    const b = graph().ensureEntity({ type: 'topic', name: 'Infrastrucktur' });
    await check();
    const [insight] = forPair(a.id, b.id);
    graph().removeNode(b.id);
    // confirming the outdated question merges nothing
    const res = await app.call('insights:respond', { response: 'accept', id: insight!.id, confirmed: true });
    expect(res.ok).toBe(false);
    expect(app.services.actions.get(insight!.recommendedActionId!).status).toBe('withdrawn');
    await check();
    expect(duplicates()).toHaveLength(0);
  });

  it('merges on confirmation and the merge can be undone', async () => {
    await start();
    const ev = await event('Kickoff', { project: 'PlattformMigration' });
    await event('Review', { project: 'Plattform-Migration' });
    await event('Abnahme', { project: 'Plattform-Migration' });
    const source = graph().findByName('project', 'PlattformMigration')!;
    const target = graph().findByName('project', 'Plattform-Migration')!;
    expect(source.id).not.toBe(target.id);
    await check();
    const before = state();
    const [insight] = forPair(source.id, target.id);

    const accepted = await app.ok('insights:respond', { response: 'accept', id: insight!.id, confirmed: true } as never);

    expect(accepted.status).toBe('accepted');
    expect(graph().getEntity(source.id)).toBeUndefined();
    expect(app.services.eventRecords.get(ev.id).projectId).toBe(target.id);
    expect(graph().getEntity(target.id)!.aliases).toContain('PlattformMigration');
    const entry = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((a) => a.action === 'entity.merge')!;
    expect(entry.undoable).toBe(true);

    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(true);
    expect(state()).toEqual(before);
    // the answered question is not asked again after the undo
    await check();
    expect(forPair(source.id, target.id).map((i) => i.status)).toEqual(['accepted']);
  });

  it('withdraws other questions about an entity that was merged away', async () => {
    await start();
    await event('Release', { topic: 'Kundenportal' });
    const a = graph().findByName('topic', 'Kundenportal')!;
    const b = graph().ensureEntity({ type: 'topic', name: 'Kunden-Portal' });
    const c = graph().ensureEntity({ type: 'topic', name: 'Kundenportale' });
    await check();
    expect(duplicates('open')).toHaveLength(3);
    const [bc] = forPair(b.id, c.id);
    const [ab] = forPair(a.id, b.id);

    await app.ok('insights:respond', { response: 'accept', id: ab!.id, confirmed: true });

    expect(graph().getEntity(b.id)).toBeUndefined();
    expect(app.services.actions.get(bc!.recommendedActionId!).status).toBe('withdrawn');
    expect(duplicates('open').every((i) => !i.sourceIds.includes(b.id))).toBe(true);
    await check();
    expect(duplicates('open').map((i) => [...i.sourceIds].sort())).toEqual([[a.id, c.id].sort()]);
  });

  it('adds an optional LLM hint with names only in privacy mode „auto“', async () => {
    await start();
    app.llm.on('DuplicateHints', () => ({ pairs: [{ nr: 1, verdict: 'same', reason: 'Gleiches Wort, andere Schreibweise.' }] }));
    const a = graph().ensureEntity({ type: 'topic', name: 'Kundenportal' });
    const b = graph().ensureEntity({ type: 'topic', name: 'Kunden-Portal' });
    await check();
    expect(hintCalls()).toHaveLength(1);
    expect(hintCalls()[0]!.input).toMatch(/^1\. Thema: „(Kundenportal|Kunden-Portal)“ \/ „(Kundenportal|Kunden-Portal)“$/);
    const [insight] = forPair(a.id, b.id);
    expect(insight!.explanation).toContain('Hinweis des Sprachmodells: wahrscheinlich dasselbe – Gleiches Wort, andere Schreibweise.');
    // the hint is kept on later runs without asking again
    await check();
    expect(hintCalls()).toHaveLength(1);
    expect(forPair(a.id, b.id)[0]!.explanation).toContain('Hinweis des Sprachmodells');
  });

  it('still asks without a hint when the LLM fails', async () => {
    await start();
    app.llm.down = true;
    graph().ensureEntity({ type: 'topic', name: 'Kundenportal' });
    graph().ensureEntity({ type: 'topic', name: 'Kunden-Portal' });
    await check();
    expect(duplicates('open')).toHaveLength(1);
    expect(duplicates('open')[0]!.explanation).not.toContain('Hinweis des Sprachmodells');
  });

  it.each(['confirm', 'local_only'] as const)('sends nothing to the LLM in privacy mode %s', async (privacy) => {
    await start({ privacy });
    graph().ensureEntity({ type: 'topic', name: 'Kundenportal' });
    graph().ensureEntity({ type: 'topic', name: 'Kunden-Portal' });
    await check();
    expect(duplicates('open')).toHaveLength(1);
    expect(hintCalls()).toHaveLength(0);
  });
});
