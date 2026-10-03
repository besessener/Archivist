import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenItemInput } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const sqlite = () => app.services.database.sqlite;

/** Creates an open item; `createdAt` is set explicitly so the item kept by a merge is deterministic. */
async function item(input: Partial<OpenItemInput> & { title: string }, createdAt: string) {
  const created = await app.ok('openItems:create', { priority: 'normal', sourceIds: [], confidence: 0.9, ...input });
  sqlite().prepare('UPDATE open_items SET created_at = ? WHERE id = ?').run(createdAt, created.id);
  return created;
}

const dupInsights = async () => (await app.ok('insights:list', {})).filter((i) => i.kind === 'duplicate');

/** Every column of both items plus their reminders (compared before a merge and after its undo). */
function state(ids: string[]) {
  const q = (sql: string) =>
    sqlite()
      .prepare(sql)
      .all(...ids);
  const marks = ids.map(() => '?').join(',');
  return {
    items: (q(`SELECT * FROM open_items WHERE id IN (${marks}) ORDER BY id`) as Array<Record<string, unknown>>).map(({ updated_at: _, ...r }) => r),
    reminders: q(`SELECT * FROM reminders WHERE target_id IN (${marks}) ORDER BY id`),
    relations: sqlite().prepare('SELECT * FROM relations ORDER BY id').all(),
  };
}

describe('Duplicate open items in the archive check (#35)', () => {
  it('detects similar active items and proposes keep + take over + discard', async () => {
    const a = await item({ title: 'Angebot für Müller prüfen', topic: 'Vertrieb' }, '2026-01-01T00:00:00.000Z');
    const b = await item(
      { title: 'Angebot Müller prüfen', description: 'er wollte Rabatt', dueAt: '2026-11-15', responsible: 'Anna' },
      '2026-02-01T00:00:00.000Z',
    );
    await item({ title: 'Zahnarzt anrufen' }, '2026-01-02T00:00:00.000Z');

    const report = await app.services.consistency.run('test');
    expect(report.byKind.duplicate_open_item).toBe(1);
    const [insight] = await dupInsights();
    expect(insight).toMatchObject({ status: 'open', recommendedActionLabel: 'Zusammenführen' });
    expect(insight!.affected.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(insight!.explanation).toContain('„Angebot für Müller prüfen“ (zuerst erfasst) behalten');
    expect(insight!.explanation).toContain('Beschreibung, Fälligkeit, Verantwortlicher');
    expect(insight!.explanation).toContain('„verworfen (Duplikat)“');
    const action = app.services.actions.get(insight!.recommendedActionId!);
    expect(action).toMatchObject({ actionType: 'merge_open_items', proposedParameters: { keepId: a.id, duplicateId: b.id } });

    // a second run neither duplicates the insight nor proposes the action again
    await app.services.consistency.run('test');
    expect(await dupInsights()).toHaveLength(1);
    expect(app.services.actions.list('proposed').filter((x) => x.actionType === 'merge_open_items')).toHaveLength(1);
  });

  it('different responsible persons, projects or numbers are not duplicates; done items do not count', async () => {
    await item({ title: 'Präsentation vorbereiten', responsible: 'Anna' }, '2026-01-01T00:00:00.000Z');
    await item({ title: 'Präsentation vorbereiten', responsible: 'Bernd' }, '2026-01-02T00:00:00.000Z');
    await item({ title: 'Budget 2026 planen' }, '2026-01-03T00:00:00.000Z');
    await item({ title: 'Budget 2027 planen' }, '2026-01-04T00:00:00.000Z');
    await item({ title: 'Release testen', project: 'Alpha' }, '2026-01-05T00:00:00.000Z');
    await item({ title: 'Release testen', project: 'Beta' }, '2026-01-06T00:00:00.000Z');
    const done = await item({ title: 'Steuererklärung abgeben' }, '2026-01-07T00:00:00.000Z');
    await item({ title: 'Steuererklärung abgeben' }, '2026-01-08T00:00:00.000Z');
    await app.ok('openItems:close', { id: done.id, status: 'resolved', confirmed: true });

    await app.services.consistency.run('test');
    expect(await dupInsights()).toHaveLength(0);
  });

  it('merging takes over missing details, sources and reminders; the duplicate item stays as „verworfen (Duplikat)“', async () => {
    const decision = await app.ok('decisions:create', {
      title: 'Rabatt gewähren',
      decisionText: 'Müller bekommt 5 % Rabatt',
      decidedAt: '2026-09-01',
      topic: 'Vertrieb',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    const a = await item({ title: 'Angebot für Müller prüfen', description: 'Konditionen klären', sourceIds: ['msg-1'] }, '2026-01-01T00:00:00.000Z');
    const b = await item(
      {
        title: 'Angebot Müller prüfen',
        description: 'er wollte Rabatt',
        dueAt: '2026-11-15',
        responsible: 'Anna',
        project: 'Kunde Müller',
        sourceIds: ['msg-1', decision.id],
      },
      '2026-02-01T00:00:00.000Z',
    );
    const reminder = await app.ok('reminders:create', { targetType: 'open_item', targetId: b.id, title: b.title, remindAt: '2099-01-01T08:00:00.000Z' });

    await app.services.consistency.run('test');
    const [insight] = await dupInsights();
    expect(insight!.explanation).toContain('Erinnerungen');
    await app.ok('insights:respond', { response: 'accept', id: insight!.id, confirmed: true });
    expect(app.services.actions.get(insight!.recommendedActionId!).status).toBe('executed');

    const items = await app.ok('openItems:list', {});
    expect(items).toHaveLength(2); // nothing deleted
    const kept = items.find((i) => i.id === a.id)!;
    const discarded = items.find((i) => i.id === b.id)!;
    expect(kept).toMatchObject({
      status: 'open',
      title: 'Angebot für Müller prüfen',
      description: 'Konditionen klären\ner wollte Rabatt',
      responsibleName: 'Anna',
      projectName: 'Kunde Müller',
      sourceIds: ['msg-1', decision.id],
      reminderAt: '2099-01-01T08:00:00.000Z',
      duplicateOfId: null,
    });
    expect(kept.dueAt?.slice(0, 10)).toBe('2026-11-15');
    expect(discarded).toMatchObject({ status: 'dismissed', duplicateOfId: a.id, reminderAt: null });
    expect((await app.ok('reminders:list', {})).find((r) => r.id === reminder.id)!.targetId).toBe(a.id);
    // the kept item now also results from the decision of the duplicate
    const rel = sqlite()
      .prepare("SELECT status FROM relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = 'results_from'")
      .get(a.id, decision.id);
    expect(rel).toEqual({ status: 'confirmed' });

    // the cause is gone: the next run closes the hint and proposes nothing new
    await app.services.consistency.run('test');
    expect(await dupInsights()).toHaveLength(0);
    expect(app.services.actions.list('proposed').filter((x) => x.actionType === 'merge_open_items')).toHaveLength(0);
  });

  it('undo restores both items, reminders and relations exactly', async () => {
    const a = await item({ title: 'Angebot für Müller prüfen' }, '2026-01-01T00:00:00.000Z');
    const b = await item(
      { title: 'Angebot Müller prüfen', description: 'er wollte Rabatt', topic: 'Vertrieb', responsible: 'Anna' },
      '2026-02-01T00:00:00.000Z',
    );
    await app.ok('reminders:create', { targetType: 'open_item', targetId: b.id, title: b.title, remindAt: '2099-01-01T08:00:00.000Z' });
    const before = state([a.id, b.id]);

    const r = app.services.openItemDuplicates.merge(a.id, b.id);
    expect(r.takenOver).toEqual(['Beschreibung', 'Verantwortlicher', 'Thema', 'Erinnerungen']);
    const entry = (await app.ok('audit:list', {})).find((e) => e.id === r.auditId)!;
    expect(entry).toMatchObject({ action: 'open_item.merge_duplicate', undoable: true });

    const u = await app.ok('audit:undo', { auditId: r.auditId });
    expect(u).toMatchObject({ undone: true, conflicts: [] });
    expect(state([a.id, b.id])).toEqual(before);
    expect((await app.ok('openItems:list', { onlyActive: true })).map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('undo refuses with a hint when an item was changed since the merge', async () => {
    const a = await item({ title: 'Angebot für Müller prüfen' }, '2026-01-01T00:00:00.000Z');
    const b = await item({ title: 'Angebot Müller prüfen', description: 'er wollte Rabatt' }, '2026-02-01T00:00:00.000Z');
    const r = app.services.openItemDuplicates.merge(a.id, b.id);
    await new Promise((res) => setTimeout(res, 5));
    await app.ok('openItems:update', { id: a.id, patch: { description: 'neu formuliert' } });

    const u = await app.ok('audit:undo', { auditId: r.auditId });
    expect(u.undone).toBe(false);
    expect(u.conflicts).toEqual(['Der behaltene Punkt „Angebot für Müller prüfen“ wurde seit der Zusammenführung verändert.']);
    expect((await app.ok('openItems:list', {})).find((i) => i.id === b.id)!.status).toBe('dismissed');
  });

  it('only active, distinct items can be merged', async () => {
    const a = await item({ title: 'Angebot prüfen' }, '2026-01-01T00:00:00.000Z');
    const b = await item({ title: 'Angebot prüfen' }, '2026-01-02T00:00:00.000Z');
    expect(() => app.services.openItemDuplicates.merge(a.id, a.id)).toThrow(/mit sich selbst/);
    await app.ok('openItems:close', { id: b.id, status: 'resolved', confirmed: true });
    expect(() => app.services.openItemDuplicates.merge(a.id, b.id)).toThrow(/Nur aktive/);
  });

  it('„Verschieden“ (reject) is remembered permanently – also after a rename', async () => {
    const a = await item({ title: 'Angebot für Müller prüfen' }, '2026-01-01T00:00:00.000Z');
    await item({ title: 'Angebot Müller prüfen' }, '2026-02-01T00:00:00.000Z');
    await app.services.consistency.run('test');
    const [insight] = await dupInsights();
    await app.ok('insights:respond', { response: 'reject', id: insight!.id });
    expect(app.services.actions.get(insight!.recommendedActionId!).status).toBe('rejected');

    await app.ok('openItems:update', { id: a.id, patch: { title: 'Angebot von Müller prüfen' } });
    await app.services.consistency.run('test');
    expect((await dupInsights()).map((i) => i.status)).toEqual(['rejected']);
    expect((await app.ok('openItems:list', { onlyActive: true })).length).toBe(2);

    // still remembered after the pair was temporarily not detected (closed and reopened)
    await app.ok('openItems:close', { id: a.id, status: 'resolved', confirmed: true });
    await app.services.consistency.run('test');
    const closed = (await app.ok('audit:list', {})).find((e) => e.action === 'open_item.close' && e.entityIds.includes(a.id))!;
    expect((await app.ok('audit:undo', { auditId: closed.id })).undone).toBe(true);
    await app.services.consistency.run('test');
    expect((await dupInsights()).map((i) => i.status)).toEqual(['rejected']);
  });

  it('an open hint disappears when the cause is gone', async () => {
    const a = await item({ title: 'Angebot für Müller prüfen' }, '2026-01-01T00:00:00.000Z');
    await item({ title: 'Angebot Müller prüfen' }, '2026-02-01T00:00:00.000Z');
    await app.services.consistency.run('test');
    expect(await dupInsights()).toHaveLength(1);
    const [insight] = await dupInsights();
    await app.ok('openItems:close', { id: a.id, status: 'resolved', confirmed: true });
    await app.services.consistency.run('test');
    expect(await dupInsights()).toHaveLength(0);
    expect(app.services.actions.get(insight!.recommendedActionId!).status).toBe('withdrawn');
  });

  it('an outdated proposal is not executed but withdrawn', async () => {
    const a = await item({ title: 'Angebot für Müller prüfen' }, '2026-01-01T00:00:00.000Z');
    const b = await item({ title: 'Angebot Müller prüfen', description: 'er wollte Rabatt' }, '2026-02-01T00:00:00.000Z');
    await app.services.consistency.run('test');
    const [insight] = await dupInsights();
    await app.ok('openItems:close', { id: b.id, status: 'dismissed', confirmed: true });

    const res = await app.services.actions.resolve(insight!.recommendedActionId!, 'approve', { confirmed: true });
    expect(res.status).toBe('withdrawn');
    expect(res.result).toContain('Nur aktive offene Punkte');
    const items = await app.ok('openItems:list', {});
    expect(items.find((i) => i.id === a.id)!.description).toBeNull();
    expect(items.find((i) => i.id === b.id)!.duplicateOfId).toBeNull();
  });
});

describe('Duplicate check when creating in the chat (#35)', () => {
  const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

  it('asks back for the same item, even when the new title is shorter', async () => {
    await item({ title: 'Angebot für Müller prüfen', description: 'Rabatt klären', responsible: 'Anna' }, '2026-01-01T00:00:00.000Z');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Angebot Müller', responsible: 'Anna' } }));
    const r = await send('Neuer Punkt: Angebot Müller, Anna kümmert sich');
    expect(r.assistantMessage.content).toBe('Gibt es schon: ‚Angebot für Müller prüfen‘ – ergänzen oder neu anlegen?');
    expect(await app.ok('openItems:list', {})).toHaveLength(1);
  });

  it('creates without asking when the responsible person or project differs', async () => {
    await item({ title: 'Präsentation vorbereiten', responsible: 'Anna' }, '2026-01-01T00:00:00.000Z');
    await item({ title: 'Release testen', project: 'Alpha' }, '2026-01-02T00:00:00.000Z');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Präsentation vorbereiten', responsible: 'Bernd' } }));
    const r1 = await send('Bernd muss die Präsentation vorbereiten');
    expect(r1.assistantMessage.content).toMatch(/^Offenen Punkt angelegt/);
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', project: 'Beta', openItem: { title: 'Release testen' } }));
    const r2 = await send('Für Beta: Release testen');
    expect(r2.assistantMessage.content).toMatch(/^Offenen Punkt angelegt/);
    expect(await app.ok('openItems:list', {})).toHaveLength(4);
  });

  it('recognizes the responsible person via an alias too', async () => {
    const anna = app.services.graph.ensureEntity('person', 'Anna Schmidt');
    app.services.graph.addAlias(anna.id, 'Anna');
    await item({ title: 'Präsentation vorbereiten', responsible: 'Anna Schmidt' }, '2026-01-01T00:00:00.000Z');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Präsentation vorbereiten', responsible: 'Anna' } }));
    const r = await send('Anna muss die Präsentation vorbereiten');
    expect(r.assistantMessage.content).toBe('Gibt es schon: ‚Präsentation vorbereiten‘ – ergänzen oder neu anlegen?');
  });
});
