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
const sqlite = () => app.services.database.sqlite;

/** Indexed search content of a record (FTS). */
const indexed = (id: string) =>
  (sqlite().prepare('SELECT content FROM search_fts WHERE entity_id = ?').all(id) as Array<{ content: string }>).map((r) => r.content).join('\n');

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
}

/** Full snapshot of every table a merge may touch (compared before the merge and after its undo). */
function state() {
  const all = (q: string) => sqlite().prepare(q).all();
  return {
    entities: all('SELECT * FROM entities ORDER BY id'),
    relations: all('SELECT * FROM relations ORDER BY id'),
    documents: all('SELECT id, topic_id, project_id, persons, tags, updated_at FROM documents ORDER BY id'),
    decisions: all('SELECT id, topic_id, project_id, participants, updated_at FROM decisions ORDER BY id'),
    openItems: all('SELECT id, topic_id, project_id, responsible_person_id, updated_at FROM open_items ORDER BY id'),
    events: all('SELECT id, topic_id, project_id, updated_at FROM events ORDER BY id'),
  };
}

async function archivedDoc(title: string, meta: { topic?: string; project?: string; persons?: string[]; tags?: string[] }): Promise<string> {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title,
    summary: 'Zusammenfassung',
    mainTopic: meta.topic ?? null,
    project: meta.project ?? null,
    persons: meta.persons ?? [],
    dates: [],
    tags: meta.tags ?? [],
    location: { categoryPath: 'work/notes', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
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

const decision = (title: string, extra: { topic?: string; project?: string; participants?: string[] }) =>
  app.ok('decisions:create', {
    decisionText: title,
    title,
    decidedAt: '2026-09-01',
    participants: extra.participants ?? ['Anna'],
    topic: extra.topic,
    project: extra.project,
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

describe('Zusammenführen von Themen (#33)', () => {
  it('hängt Dokumente, Entscheidungen, offene Punkte, Ereignisse und Beziehungen um und indexiert neu', async () => {
    const doc = await archivedDoc('Altbericht', { topic: 'Altthema' });
    const otherDoc = await archivedDoc('Neubericht', { topic: 'Neuthema' });
    const dec = await decision('Wir starten Altthema', { topic: 'Altthema' });
    const item = await app.ok('openItems:create', { title: 'Altthema planen', topic: 'Altthema', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const ev = await app.ok('events:create', { title: 'Auftakt', occurredAt: '2026-09-02', topic: 'Altthema', sourceIds: [] });
    const alt = graph().findByName('topic', 'Altthema')!;
    const neu = graph().findByName('topic', 'Neuthema')!;
    // a duplicate relation (doc relates to both topics) is combined: confirmed beats rejected, sources are unioned, max confidence
    const dup = graph().link(otherDoc, alt.id, 'relates_to', { status: 'rejected', confidence: 0.3, sourceIds: ['q1'] })!;
    const kept = graph()
      .relationsOf(otherDoc)
      .find((r) => r.targetEntityId === neu.id && r.relationType === 'relates_to')!;
    await waitFor(
      () => indexed(dec.id).includes('Thema: Altthema') && indexed(item.id).includes('Thema: Altthema') && indexed(ev.id).includes('Thema: Altthema'),
    );
    expect(indexed(doc)).toContain('Thema: Altthema');

    const r = await graph().merge({ sourceIds: [alt.id], targetId: neu.id });

    expect(r).toMatchObject({ targetId: neu.id, mergedIds: [alt.id], mergedNames: ['Altthema'], referencesUpdated: 4 });
    expect(graph().getEntity(alt.id)).toBeUndefined();
    expect(graph().getEntity(neu.id)!.aliases).toEqual(['Altthema']);
    expect(graph().findByNameOrAlias('topic', 'altthema')?.id).toBe(neu.id);
    expect(app.services.documents.get(doc).topicId).toBe(neu.id);
    expect(app.services.decisions.get(dec.id).topicId).toBe(neu.id);
    expect(app.services.openItems.get(item.id).topicId).toBe(neu.id);
    expect(app.services.eventRecords.get(ev.id).topicId).toBe(neu.id);
    expect(
      graph()
        .relationsOf(doc)
        .some((x) => x.targetEntityId === neu.id),
    ).toBe(true);
    expect(
      graph()
        .relationsOf(ev.id)
        .some((x) => x.targetEntityId === neu.id),
    ).toBe(true);
    expect(graph().getRelation(dup.id)).toBeUndefined();
    expect(graph().getRelation(kept.id)).toMatchObject({ status: 'confirmed', sourceIds: [otherDoc, 'q1'], confidence: kept.confidence });
    for (const id of [doc, dec.id, item.id, ev.id]) {
      expect(indexed(id)).toContain('Thema: Neuthema');
      expect(indexed(id)).not.toContain('Thema: Altthema');
    }
  });

  it('macht die Zusammenführung exakt rückgängig (Einträge, Beziehungen, Verweise, Aliasse, Suchindex)', async () => {
    await archivedDoc('Altbericht', { topic: 'Altthema' });
    const otherDoc = await archivedDoc('Neubericht', { topic: 'Neuthema' });
    const dec = await decision('Wir starten Altthema', { topic: 'Altthema' });
    const ev = await app.ok('events:create', { title: 'Auftakt', occurredAt: '2026-09-02', topic: 'Altthema', sourceIds: [] });
    const alt = graph().findByName('topic', 'Altthema')!;
    const neu = graph().findByName('topic', 'Neuthema')!;
    graph().addAlias(alt.id, 'Altes Thema');
    graph().link(otherDoc, alt.id, 'relates_to', { status: 'rejected', confidence: 0.3, sourceIds: ['q1'] });
    await waitFor(() => indexed(dec.id).includes('Thema: Altthema') && indexed(ev.id).includes('Thema: Altthema'));
    const before = state();

    const r = await graph().merge({ sourceIds: [alt.id], targetId: neu.id });
    expect(graph().getEntity(neu.id)!.aliases).toEqual(['Altthema', 'Altes Thema']);
    expect(state()).not.toEqual(before);

    const entry = (await app.ok('audit:list', { limit: 10, onlyUndoable: true })).find((a) => a.id === r.auditId);
    expect(entry).toMatchObject({ action: 'entity.merge', undoable: true });
    const u = await app.ok('audit:undo', { auditId: r.auditId });
    expect(u).toMatchObject({ undone: true, conflicts: [] });
    expect(u.message).toContain('„Altthema“');
    expect(state()).toEqual(before);
    expect(indexed(dec.id)).toContain('Thema: Altthema');
    expect(indexed(ev.id)).toContain('Thema: Altthema');
  });

  it('verweigert das Rückgängigmachen mit verständlicher Meldung, wenn seither etwas geändert wurde', async () => {
    const dec = await decision('Wir starten Altthema', { topic: 'Altthema' });
    const neu = graph().ensureEntity('topic', 'Neuthema');
    const alt = graph().findByName('topic', 'Altthema')!;
    const r = await graph().merge({ sourceIds: [alt.id], targetId: neu.id });

    await app.ok('decisions:update', { id: dec.id, patch: { rationale: 'Später ergänzt' } });
    const u = await app.ok('audit:undo', { auditId: r.auditId });
    expect(u.undone).toBe(false);
    expect(u.conflicts).toContain('Die Entscheidung „Wir starten Altthema“ wurde seit der Zusammenführung verändert.');
    expect(graph().getEntity(alt.id)).toBeUndefined();
    expect(app.services.decisions.get(dec.id).topicId).toBe(neu.id);
  });

  it('verweigert das Rückgängigmachen, wenn der alte Name inzwischen neu angelegt wurde', async () => {
    const neu = graph().ensureEntity('topic', 'Neuthema');
    const alt = graph().ensureEntity('topic', 'Altthema');
    const r = await graph().merge({ sourceIds: [alt.id], targetId: neu.id });
    graph().ensureEntity('topic', 'Altthema');

    const u = await app.ok('audit:undo', { auditId: r.auditId });
    expect(u.undone).toBe(false);
    expect(u.conflicts).toContain('„Altthema“ wurde seit der Zusammenführung neu angelegt. Bitte zuerst diesen Eintrag bereinigen.');
  });

  it('lehnt ungleiche Typen ohne Freigabe und nicht zusammenführbare Einträge ab', async () => {
    const topic = graph().ensureEntity('topic', 'prod-plat');
    const project = graph().ensureEntity('project', 'Prod Plat');
    const person = graph().ensureEntity('person', 'Anna');
    await expect(graph().merge({ sourceIds: [topic.id], targetId: project.id })).rejects.toThrow('Nur gleichartige Einträge');
    await expect(graph().merge({ sourceIds: [person.id], targetId: project.id, allowCrossType: true })).rejects.toThrow('Nur gleichartige Einträge');
    const dec = await decision('Etwas', { topic: 'prod-plat' });
    await expect(graph().merge({ sourceIds: [dec.id], targetId: topic.id })).rejects.toThrow('kann nicht zusammengeführt werden');
    await expect(graph().merge({ sourceIds: [topic.id], targetId: topic.id })).rejects.toThrow('Keine Einträge');
    expect(graph().getEntity(topic.id)).toBeDefined();
  });
});

describe('Zusammenführen von Personen (#33)', () => {
  it('ersetzt Namen in Beteiligten- und Personenlisten, übernimmt Verantwortliche und fasst Beziehungen zusammen', async () => {
    const doc = await archivedDoc('Protokoll', { persons: ['Monika', 'Bob'] });
    const dec = await decision('Budget freigegeben', { participants: ['Monika', 'Monika Lor-Zade', 'Bob'] });
    const item = await app.ok('openItems:create', { title: 'Angebot einholen', responsible: 'Monika', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const monika = graph().findByName('person', 'Monika')!;
    const full = graph().findByName('person', 'Monika Lor-Zade')!;
    await waitFor(() => indexed(item.id).includes('Verantwortlich: Monika') && indexed(dec.id).includes('Beteiligte:'));
    const before = state();

    const r = await graph().merge({ sourceIds: [monika.id], targetId: full.id });

    expect(r.referencesUpdated).toBe(3);
    expect(app.services.decisions.get(dec.id).participants).toEqual(['Monika Lor-Zade', 'Bob']);
    expect(app.services.documents.get(doc).persons).toEqual(['Monika Lor-Zade', 'Bob']);
    expect(app.services.openItems.get(item.id)).toMatchObject({ responsiblePersonId: full.id, responsibleName: 'Monika Lor-Zade' });
    // both persons participated in the decision: one relation remains
    const participated = graph()
      .relationsOf(dec.id, { types: ['participated_in'] })
      .filter((x) => x.sourceEntityId === full.id);
    expect(participated).toHaveLength(1);
    expect(
      graph()
        .relationsOf(dec.id)
        .some((x) => x.sourceEntityId === monika.id || x.targetEntityId === monika.id),
    ).toBe(false);
    expect(indexed(dec.id)).toContain('Beteiligte: Monika Lor-Zade, Bob');
    expect(indexed(item.id)).toContain('Verantwortlich: Monika Lor-Zade');
    expect(indexed(doc)).toContain('Personen: Monika Lor-Zade, Bob');

    expect((await app.ok('audit:undo', { auditId: r.auditId })).undone).toBe(true);
    expect(state()).toEqual(before);
    expect(indexed(item.id)).toContain('Verantwortlich: Monika\n');
  });
});

describe('Thema ↔ Projekt (#33)', () => {
  it('führt ein Thema in ein Projekt zusammen (Zieltyp gewinnt) und macht es exakt rückgängig', async () => {
    const ev = await app.ok('events:create', { title: 'Kickoff', occurredAt: '2026-09-03', topic: 'prod-plat', sourceIds: [] });
    const dec = await decision('prod-plat geht live', { topic: 'prod-plat', project: 'Prod Plat' });
    const item = await app.ok('openItems:create', {
      title: 'Release',
      topic: 'prod-plat',
      project: 'Anderes Projekt',
      priority: 'normal',
      sourceIds: [],
      confidence: 0.9,
    });
    const topic = graph().findByName('topic', 'prod-plat')!;
    const project = graph().findByName('project', 'Prod Plat')!;
    await waitFor(() => indexed(ev.id).includes('Thema: prod-plat') && indexed(dec.id).includes('Thema: prod-plat'));
    const before = state();

    const r = await graph().merge({ sourceIds: [topic.id], targetId: project.id, allowCrossType: true });

    expect(r.targetType).toBe('project');
    expect(graph().getEntity(topic.id)).toBeUndefined();
    expect(app.services.eventRecords.get(ev.id)).toMatchObject({ topicId: null, projectId: project.id });
    expect(app.services.decisions.get(dec.id)).toMatchObject({ topicId: null, projectId: project.id });
    // an occupied project slot is kept; the relation still links the open item with the merged project
    expect(app.services.openItems.get(item.id)).toMatchObject({ topicId: null, projectName: 'Anderes Projekt' });
    expect(
      graph()
        .relationsOf(item.id)
        .some((x) => x.targetEntityId === project.id),
    ).toBe(true);
    expect(graph().getEntity(project.id)!.aliases).toEqual([]); // same normalized name: no extra alias needed
    expect(indexed(ev.id)).toContain('Projekt: Prod Plat');
    expect(indexed(ev.id)).not.toContain('Thema:');

    expect((await app.ok('audit:undo', { auditId: r.auditId })).undone).toBe(true);
    expect(state()).toEqual(before);
    expect(indexed(ev.id)).toContain('Thema: prod-plat');
  });
});

describe('Mehrere Zusammenführungen eines Laufs (#33)', () => {
  it('protokolliert einen Audit-Eintrag und nimmt alle mit einem Rückgängig zurück – auch verkettete', async () => {
    const ev = await app.ok('events:create', { title: 'Treffen', occurredAt: '2026-09-04', topic: 'A-Thema', sourceIds: [] });
    await decision('B entschieden', { topic: 'B-Thema', participants: ['Bob B.'] });
    await decision('C entschieden', { topic: 'C-Thema', participants: ['Bob'] });
    const id = (type: 'topic' | 'person', name: string) => graph().findByName(type, name)!.id;
    const before = state();
    const auditsBefore = (await app.ok('audit:list', { limit: 100 })).length;

    const batch = await graph().mergeMany(
      [
        { sourceIds: [id('topic', 'A-Thema')], targetId: id('topic', 'B-Thema') },
        { sourceIds: [id('topic', 'B-Thema')], targetId: id('topic', 'C-Thema') },
        { sourceIds: [id('person', 'Bob B.')], targetId: id('person', 'Bob') },
      ],
      { trigger: 'consistency' },
    );

    expect(batch.results).toHaveLength(3);
    expect((await app.ok('audit:list', { limit: 100 })).length).toBe(auditsBefore + 1);
    expect(app.services.eventRecords.get(ev.id).topicName).toBe('C-Thema');
    expect(graph().findByName('topic', 'C-Thema')!.aliases).toEqual(['B-Thema', 'A-Thema']);

    expect((await app.ok('audit:undo', { auditId: batch.auditId })).undone).toBe(true);
    expect(state()).toEqual(before);
  });

  it('nimmt bei einem Fehler im Lauf nichts davon vor', async () => {
    const a = graph().ensureEntity('topic', 'A-Thema');
    const b = graph().ensureEntity('topic', 'B-Thema');
    const before = state();
    await expect(
      graph().mergeMany([
        { sourceIds: [a.id], targetId: b.id },
        { sourceIds: ['gibt-es-nicht'], targetId: b.id },
      ]),
    ).rejects.toThrow('nicht gefunden');
    expect(state()).toEqual(before);
  });
});

describe('Agentenaktionen zum Zusammenführen (#33)', () => {
  it('merge_topics ist rückgängig machbar', async () => {
    const ev = await app.ok('events:create', { title: 'Treffen', occurredAt: '2026-09-04', topic: 'Altthema', sourceIds: [] });
    const alt = graph().findByName('topic', 'Altthema')!;
    const neu = graph().ensureEntity('topic', 'Neuthema');
    const before = state();
    const action = await app.ok('knowledge:proposeMerge', { sourceTopicId: alt.id, targetTopicId: neu.id });
    const done = await app.ok('actions:resolve', { decision: 'approve', actionId: action.id, confirmed: true } as never);
    expect(done).toMatchObject({ status: 'executed', result: expect.stringContaining('Themen zusammengeführt') });
    expect(app.services.eventRecords.get(ev.id).topicId).toBe(neu.id);

    const entry = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((a) => a.action === 'topics.merge')!;
    expect(entry.undoable).toBe(true);
    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(true);
    expect(state()).toEqual(before);
  });

  it('merge_entities führt mehrere Einträge auch über Thema/Projekt hinweg zusammen', async () => {
    const topic = graph().ensureEntity('topic', 'prod-plat');
    const project = graph().ensureEntity('project', 'Prod Plat');
    const other = graph().ensureEntity('project', 'Produktplattform');
    const action = app.services.actions.propose({
      actionType: 'merge_entities',
      label: 'Zusammenführen',
      rationale: 'Test',
      confidence: 0.9,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { sourceIds: [topic.id, other.id], targetId: project.id, allowCrossType: true },
    });
    const done = await app.services.actions.resolve(action.id, 'approve', { confirmed: true });
    expect(done.status).toBe('executed');
    expect(done.result).toContain('„prod-plat“, „Produktplattform“ mit „Prod Plat“ zusammengeführt');
    expect(graph().getEntity(project.id)!.aliases).toEqual(['Produktplattform']);
    expect(graph().findByNameOrAlias('project', 'produktplattform')?.id).toBe(project.id);
  });
});
