import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const userText = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? '';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const notesInGraph = () => app.services.graph.listEntities({ type: 'note' });
const searchIds = async (query: string) => (await app.ok('search:global', { query })).map((h) => h.id);
const duplicateInsights = (status: 'open' | 'accepted' | 'rejected' = 'open') => app.services.insights.list(status).filter((i) => i.kind === 'duplicate');
const insightFor = (id: string, status: 'open' | 'accepted' | 'rejected' = 'open') => duplicateInsights(status).find((i) => i.sourceIds.includes(id));
const accept = (id: string) => app.ok('insights:respond', { response: 'accept', id, confirmed: true, strongConfirmed: false });
const reject = (id: string) => app.ok('insights:respond', { response: 'reject', id });
const lastAudit = (action: string) => app.services.audit.list({ limit: 50 }).find((a) => a.action === action)!;
const check = () => app.services.consistency.run('manual');

/** Records created in the same millisecond have no order; the older one is kept. */
const tick = () => new Promise((r) => setTimeout(r, 5));

const PREFIX = 'Für das Sommerfest am 12. Juli brauchen wir noch Zelte, Bänke und Tische vom Sportverein nebenan, ';

describe('Notes in the chat (#32, criterion 1)', () => {
  it('every note gets its own entry, even when the first 70 characters are the same', async () => {
    app.llm.on('ChatIntent', (_s, input) => intent({ intent: 'note_capture', segment: userText(input), note: userText(input) }));
    const r1 = await app.ok('chat:send', { text: `${PREFIX}Teil eins über Getränke.` });
    const r2 = await app.ok('chat:send', { text: `${PREFIX}Teil zwei über das Essen.`, conversationId: r1.conversationId });
    expect(r1.assistantMessage.content).toContain('Notiz gespeichert');
    expect(r2.assistantMessage.content).toContain('Notiz gespeichert');

    const notes = notesInGraph();
    expect(notes).toHaveLength(2);
    const drinks = notes.find((n) => n.description?.includes('Getränke'))!;
    const food = notes.find((n) => n.description?.includes('Essen'))!;
    expect(drinks.id).not.toBe(food.id);
    expect(drinks.description).not.toContain('Essen');
    await vi.waitFor(async () => {
      expect(await searchIds('Getränke')).toContain(drinks.id);
      expect(await searchIds('Essen')).toContain(food.id);
    });

    // the archive check does not consider them duplicates either
    await check();
    expect(duplicateInsights()).toHaveLength(0);
  });
});

describe('Duplicate notes (archive check)', () => {
  it('detects identical notes, proposes merging and allows undoing it', async () => {
    const topic = app.services.graph.ensureEntity({ type: 'topic', name: 'Sommerfest' });
    const person = app.services.graph.ensureEntity({ type: 'person', name: 'Anna Berg' });
    // the more complete note is kept
    const first = await app.services.notes.create({
      content: 'Zelte beim Sportverein nebenan ausleihen',
      links: [{ targetId: topic.id, relationType: 'relates_to' }],
    });
    const second = await app.services.notes.create({
      content: 'Beim Sportverein Zelte ausleihen.',
      links: [
        { targetId: topic.id, relationType: 'relates_to' },
        { targetId: person.id, relationType: 'concerns' },
      ],
    });
    await app.services.notes.create({ content: 'Getränke beim Großmarkt bestellen' });

    const report = await check();
    expect(report.byKind.duplicate_note).toBe(1);
    const insight = insightFor(first.id)!;
    expect(insight).toBeDefined();
    expect(insight.sourceIds.sort()).toEqual([first.id, second.id].sort());
    expect(insight.explanation).toContain('nichts gelöscht');
    const action = app.services.actions.get(insight.recommendedActionId!);
    expect(action).toMatchObject({ actionType: 'merge_notes', status: 'proposed', proposedParameters: { keepId: first.id, duplicateId: second.id } });
    // nothing changes before the user decides
    expect(app.services.graph.getEntity(second.id)?.duplicateOfId).toBeNull();

    await accept(insight.id);
    expect(app.services.actions.get(action.id).status).toBe('executed');
    const dup = app.services.graph.getEntity(second.id)!;
    expect(dup.duplicateOfId).toBe(first.id);
    expect(dup.description).toBe('Beim Sportverein Zelte ausleihen.'); // nothing deleted
    // the kept note took over the missing link
    const kept = await app.ok('knowledge:getEntity', { id: first.id });
    expect(kept.relations.some((r) => r.other.id === person.id && r.relationType === 'concerns')).toBe(true);
    await vi.waitFor(async () => expect(await searchIds('Sportverein Zelte')).not.toContain(second.id));

    // the pair is no longer reported
    await check();
    expect(insightFor(first.id)).toBeUndefined();

    const undo = await app.ok('audit:undo', { auditId: lastAudit('note.merge_duplicate').id });
    expect(undo).toMatchObject({ undone: true, conflicts: [] });
    expect(app.services.graph.getEntity(second.id)?.duplicateOfId).toBeNull();
    const after = await app.ok('knowledge:getEntity', { id: first.id });
    expect(after.relations.some((r) => r.other.id === person.id)).toBe(false);
    await vi.waitFor(async () => expect(await searchIds('Sportverein Zelte')).toContain(second.id));

    // after the undo the archive check asks again
    await check();
    expect(insightFor(first.id)).toBeDefined();
  });

  it('undo is refused when the discarded note was changed since', async () => {
    const a = await app.services.notes.create({ content: 'Steuerunterlagen bis Ende Mai sammeln' });
    const b = await app.services.notes.create({ content: 'Steuerunterlagen bis Ende Mai sammeln!' });
    const r = app.services.noteEventDuplicates.mergeNotes(a.id, b.id);
    app.services.graph.registerNode({ type: 'note', id: b.id, name: b.name, description: 'Steuerunterlagen bis Ende Mai sammeln – erledigt' });
    const res = await app.ok('audit:undo', { auditId: r.auditId });
    expect(res.undone).toBe(false);
    expect(res.conflicts.join(' ')).toMatch(/verändert/);
    expect(() => app.services.noteEventDuplicates.mergeNotes(a.id, b.id)).toThrow(/bereits als Duplikat/);
  });

  it('„Verschieden“ (reject) is remembered permanently', async () => {
    const a = await app.services.notes.create({ content: 'Angebot vom Dachdecker vergleichen' });
    const b = await app.services.notes.create({ content: 'Angebot vom Dachdekcer vergleichen' });
    await check();
    const insight = insightFor(a.id)!;
    const actionId = insight.recommendedActionId!;
    await reject(insight.id);
    expect(app.services.actions.get(actionId).status).toBe('rejected');

    await check();
    expect(insightFor(a.id)).toBeUndefined();
    expect(insightFor(a.id, 'rejected')?.id).toBe(insight.id);

    // the pair temporarily disappears (one note is edited) and comes back: still not asked again
    app.services.graph.registerNode({ type: 'note', id: b.id, name: b.name, description: 'Ganz anderer Inhalt über den Garten' });
    await check();
    app.services.graph.registerNode({ type: 'note', id: b.id, name: b.name, description: 'Angebot vom Dachdekcer vergleichen' });
    await check();
    expect(insightFor(a.id)).toBeUndefined();
    expect(insightFor(a.id, 'rejected')?.id).toBe(insight.id);
    expect(app.services.graph.getEntity(b.id)?.duplicateOfId).toBeNull();
  });
});

describe('Duplicate events (archive check)', () => {
  it('detects the same date with a similar title, takes over missing details and can be undone', async () => {
    const keep = app.services.eventRecords.create({ title: 'Umzug nach Berlin', occurredAt: '2026-03-01', sourceIds: [] });
    await tick();
    const dup = app.services.eventRecords.create({
      title: 'Umzug',
      occurredAt: '2026-03-01',
      description: 'Umzugsfirma Schmidt, Schlüsselübergabe 9 Uhr',
      topic: 'Wohnen',
      sourceIds: ['src-1'],
    });
    app.services.eventRecords.create({ title: 'Umzug', occurredAt: '2026-04-01', sourceIds: [] }); // another day
    app.services.eventRecords.create({ title: 'Zahnarzttermin', occurredAt: '2026-03-01', sourceIds: [] }); // another title

    const report = await check();
    expect(report.byKind.duplicate_event).toBe(1);
    const insight = insightFor(keep.id)!;
    expect(insight.sourceIds.sort()).toEqual([keep.id, dup.id].sort());
    expect(insight.explanation).toMatch(/Beschreibung, Thema, Quellen/);
    expect(app.services.actions.get(insight.recommendedActionId!)).toMatchObject({
      actionType: 'merge_events',
      proposedParameters: { keepId: keep.id, duplicateId: dup.id },
    });

    await accept(insight.id);
    const kept = app.services.eventRecords.get(keep.id);
    expect(kept).toMatchObject({ description: 'Umzugsfirma Schmidt, Schlüsselübergabe 9 Uhr', topicName: 'Wohnen', sourceIds: ['src-1'], duplicateOfId: null });
    expect(app.services.eventRecords.get(dup.id)).toMatchObject({ duplicateOfId: keep.id, title: 'Umzug', topicName: 'Wohnen' });
    expect(app.services.graph.getEntity(dup.id)?.duplicateOfId).toBe(keep.id);
    const timeline = await app.ok('timeline:get', {});
    expect(timeline.some((e) => e.id === `event:${dup.id}`)).toBe(false);
    expect(timeline.some((e) => e.id === `event:${keep.id}`)).toBe(true);
    // the kept event is linked to the topic it took over
    const topicId = kept.topicId!;
    const detail = await app.ok('knowledge:getEntity', { id: keep.id });
    expect(detail.relations.some((r) => r.other.id === topicId && r.relationType === 'relates_to')).toBe(true);
    // an identical event typed in later resolves to the kept one, not to the discarded duplicate
    expect(app.services.eventRecords.findIdentical('Umzug', '2026-03-01')).toBeUndefined();

    const undo = await app.ok('audit:undo', { auditId: lastAudit('event.merge_duplicate').id });
    expect(undo).toMatchObject({ undone: true });
    expect(app.services.eventRecords.get(keep.id)).toMatchObject({ description: null, topicId: null, sourceIds: [] });
    expect(app.services.eventRecords.get(dup.id).duplicateOfId).toBeNull();
    expect(app.services.graph.getEntity(dup.id)?.duplicateOfId).toBeNull();
    const detailAfter = await app.ok('knowledge:getEntity', { id: keep.id });
    expect(detailAfter.relations.some((r) => r.other.id === topicId)).toBe(false);
    expect((await app.ok('timeline:get', {})).some((e) => e.id === `event:${dup.id}`)).toBe(true);
  });

  it('undo is refused when the kept event was edited since', async () => {
    const a = app.services.eventRecords.create({ title: 'Kickoff Projekt Nord', occurredAt: '2026-05-04', sourceIds: [] });
    const b = app.services.eventRecords.create({ title: 'Kickoff Projekt Nord', occurredAt: '2026-05-04', description: 'mit Kunde', sourceIds: [] });
    const r = app.services.noteEventDuplicates.mergeEvents(a.id, b.id);
    expect(r.takenOver).toEqual(['Beschreibung']);
    app.services.eventRecords.update(a.id, { patch: { title: 'Kickoff Projekt Nord (verschoben)' } });
    const res = await app.ok('audit:undo', { auditId: r.auditId });
    expect(res.undone).toBe(false);
    expect(res.conflicts.join(' ')).toMatch(/behaltene Ereignis .* verändert/);
  });

  it('an outdated proposal is not executed but withdrawn', async () => {
    const a = app.services.eventRecords.create({ title: 'Sommerfest', occurredAt: '2026-07-12', sourceIds: [] });
    const b = app.services.eventRecords.create({ title: 'Sommerfest!', occurredAt: '2026-07-12', sourceIds: [] });
    await check();
    const insight = insightFor(a.id)!;
    app.services.eventRecords.delete(b.id, { confirmed: true });
    await expect(accept(insight.id)).rejects.toThrow(/nicht mehr aktuell/);
    expect(app.services.actions.get(insight.recommendedActionId!).status).toBe('withdrawn');
    expect(app.services.eventRecords.get(a.id).description).toBeNull();
  });

  it('„Verschieden“ (reject) is remembered permanently', async () => {
    const a = app.services.eventRecords.create({ title: 'Elternabend', occurredAt: '2026-09-10', sourceIds: [] });
    app.services.eventRecords.create({ title: 'Elternabend Klasse', occurredAt: '2026-09-10', sourceIds: [] });
    await check();
    const insight = insightFor(a.id)!;
    await reject(insight.id);
    await check();
    await check();
    expect(insightFor(a.id)).toBeUndefined();
    expect(insightFor(a.id, 'rejected')?.id).toBe(insight.id);
  });
});
