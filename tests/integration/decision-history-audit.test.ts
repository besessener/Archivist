import fs from 'node:fs';
import path from 'node:path';
import type { DecisionInput } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionTools } from '../../packages/core/src/agent/tools/knowledge-decisions';
import { emptyToolContext } from '../helpers/agent';
import { toolCaller, toolDepsOf } from '../helpers/agent-tools';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const create = (decisionText: string, over: Partial<DecisionInput> = {}) =>
  app.ok('decisions:create', {
    decisionText,
    topic: 'Dach',
    decidedAt: '2026-09-01',
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
    ...over,
  });

const sql = (statement: string, ...params: unknown[]) => app.services.database.sqlite.prepare(statement).run(...params);

describe('History of a decision (#193)', () => {
  it('keeps text and date before and after an edit, with the title of the decision', async () => {
    const decision = await create('Wir nehmen das Angebot von Müller.', { title: 'Angebot Müller' });
    await app.ok('decisions:update', { id: decision.id, patch: { decisionText: 'Wir nehmen das Angebot von Schulz.', decidedAt: '2026-09-15' } });
    await app.ok('decisions:update', { id: decision.id, patch: { rationale: 'Günstiger' } });

    const history = await app.ok('audit:list', { entityId: decision.id });
    expect(history.map((e) => e.action)).toEqual(['decision.update', 'decision.update', 'decision.create']);
    const [rationale, edit, created] = history;
    expect(edit!.before).toMatchObject({ decisionText: 'Wir nehmen das Angebot von Müller.', decidedAt: '2026-09-01' });
    expect(edit!.after).toMatchObject({ decisionText: 'Wir nehmen das Angebot von Schulz.', decidedAt: expect.stringContaining('2026-09-15') });
    expect(rationale!.before).not.toHaveProperty('decisionText');
    expect(rationale!.after).toMatchObject({ rationale: 'Günstiger' });
    expect(edit!.entities).toEqual([{ id: decision.id, title: 'Angebot Müller' }]);
    expect(created!.entities).toEqual([{ id: decision.id, title: 'Angebot Müller' }]);

    const other = await create('Wir streichen die Tür.', { topic: 'Tür' });
    expect((await app.ok('audit:list', { entityId: other.id })).map((e) => e.action)).toEqual(['decision.create']);
  });

  it('names a deleted entry by the title the entry recorded', async () => {
    const draft = await create('Entwurf', { asDraft: true, title: 'Mein Entwurf' });
    await app.ok('decisions:delete', { id: draft.id, confirmed: true });
    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'decision.delete')!;
    expect(entry.entities).toEqual([{ id: draft.id, title: 'Mein Entwurf' }]);
  });

  it('a created decision can be taken back, unless it was edited since', async () => {
    const decision = await create('Wir nehmen das Angebot von Müller.');
    const entry = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'decision.create')!;
    expect(entry.undoable).toBe(true);
    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(true);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect(app.services.graph.getEntity(decision.id)).toBeUndefined();

    const edited = await create('Wir nehmen das Angebot von Schulz.');
    await app.ok('decisions:update', { id: edited.id, patch: { rationale: 'Günstiger' } });
    const second = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'decision.create')!;
    const result = await app.ok('audit:undo', { auditId: second.id });
    expect(result.undone).toBe(false);
    expect(result.conflicts).toEqual(['Der Eintrag wurde seit dem Anlegen bearbeitet.']);
    expect(await app.ok('decisions:list', {})).toHaveLength(1);
  });

  it('lists as many entries as asked for instead of a fixed 200', async () => {
    for (let i = 0; i < 6; i += 1) app.services.audit.log({ action: `test.entry${i}`, actor: 'user', trigger: 'test', confirmed: true });
    expect(await app.ok('audit:list', { limit: 4 })).toHaveLength(4);
    expect((await app.ok('audit:list', { limit: 4 }))[0]!.action).toBe('test.entry5');
    expect((await app.ok('audit:list', { limit: 1000 })).length).toBeGreaterThanOrEqual(6);
    expect((await app.call('audit:list', { limit: 5000 })).ok).toBe(true);
    expect((await app.call('audit:list', { limit: 5001 })).ok).toBe(false);
  });
});

describe('Tamper evidence of the audit log (#193, REL-16)', () => {
  const entries = (count: number) => {
    for (let i = 0; i < count; i += 1)
      app.services.audit.log({ action: `test.entry${i}`, actor: 'user', trigger: 'test', confirmed: true, entityIds: [`e${i}`] });
  };
  const ids = () => (app.services.database.sqlite.prepare('SELECT id FROM audit_log ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id);

  it('is intact after normal use, including undo and amendments of the outcome', async () => {
    const decision = await create('Wir nehmen das Angebot von Müller.');
    await app.ok('decisions:update', { id: decision.id, patch: { rationale: 'Günstiger' } });
    const update = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'decision.update')!;
    await app.ok('audit:undo', { auditId: update.id });
    const entry = app.services.audit.log({ action: 'test.amend', actor: 'user', trigger: 'test', confirmed: true });
    app.services.audit.amend(entry, { after: { done: true }, undo: { type: 'composite', data: { steps: [] } } });

    const result = await app.ok('audit:verify', {});
    expect(result.brokenEntryId).toBeNull();
    expect(result.checked).toBe(ids().length);
  });

  it('names the first entry that was changed after it was written', async () => {
    entries(4);
    const [, second] = ids();
    sql('UPDATE audit_log SET action = ? WHERE id = ?', 'test.forged', second);
    expect(await app.ok('audit:verify', {})).toMatchObject({ brokenEntryId: second });
  });

  it('notices a removed entry in the middle and an inserted one', async () => {
    entries(4);
    const [, second, third] = ids();
    sql('DELETE FROM audit_log WHERE id = ?', second);
    expect((await app.ok('audit:verify', {})).brokenEntryId).toBe(third);

    sql(
      'INSERT INTO audit_log (id, at, action, actor, trigger, confirmed, entity_ids, paths, success) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)',
      'x',
      '2026-01-01T00:00:00.000Z',
      'forged',
      'user',
      'ui',
      '[]',
      '[]',
    );
    expect((await app.ok('audit:verify', {})).brokenEntryId).toBe(third);
  });

  it('does not cover entries from before the chain, and starts at the first chained one', async () => {
    sql('DELETE FROM audit_log');
    sql("DELETE FROM app_state WHERE key = 'audit.chainAnchor'");
    sql(
      'INSERT INTO audit_log (id, at, action, actor, trigger, confirmed, entity_ids, paths, success) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)',
      'legacy',
      '2026-01-01T00:00:00.000Z',
      'old.entry',
      'user',
      'ui',
      '[]',
      '[]',
    );
    entries(2);
    expect(await app.ok('audit:verify', {})).toEqual({ checked: 2, brokenEntryId: null, truncated: false });
  });

  it('notices entries cut off the newest end, even after the log grew again', async () => {
    entries(4);
    const [, , third, fourth] = ids();
    sql('DELETE FROM audit_log WHERE id = ?', fourth);
    expect(await app.ok('audit:verify', {})).toMatchObject({ brokenEntryId: null, truncated: true });
    entries(1);
    expect(await app.ok('audit:verify', {})).toMatchObject({ brokenEntryId: null, truncated: true });
    expect(ids()).toContain(third);
  });

  it('notices entries cut off the oldest end, and an emptied log', async () => {
    entries(3);
    sql('DELETE FROM audit_log WHERE id = ?', ids()[0]);
    expect(await app.ok('audit:verify', {})).toMatchObject({ truncated: true });
    sql('DELETE FROM audit_log');
    expect(await app.ok('audit:verify', {})).toEqual({ checked: 0, brokenEntryId: null, truncated: true });
  });

  it('notices hashes nulled after the first chained entry', async () => {
    entries(3);
    const [first, second] = ids();
    sql('UPDATE audit_log SET hash = NULL, prev_hash = NULL WHERE id = ?', second);
    expect(await app.ok('audit:verify', {})).toMatchObject({ brokenEntryId: second });
    sql('UPDATE audit_log SET hash = NULL, prev_hash = NULL WHERE id = ?', first);
    expect(await app.ok('audit:verify', {})).toMatchObject({ truncated: true });
  });

  it('keeps the anchor in step with every entry, undo and amendment included', async () => {
    entries(2);
    const entry = app.services.audit.log({ action: 'test.amend', actor: 'user', trigger: 'test', confirmed: true });
    app.services.audit.amend(entry, { after: { done: true }, undo: { type: 'composite', data: { steps: [] } } });
    app.services.audit.markUndone(entry);
    const anchor = JSON.parse((app.services.database.sqlite.prepare("SELECT value FROM app_state WHERE key = 'audit.chainAnchor'").get() as { value: string }).value);
    expect(anchor.count).toBe(ids().length);
    expect(await app.ok('audit:verify', {})).toMatchObject({ truncated: false });
  });

  it('seeds the anchor from the existing chain when a log from before the anchor gets its first new entry', async () => {
    entries(2);
    sql("DELETE FROM app_state WHERE key = 'audit.chainAnchor'");
    expect(await app.ok('audit:verify', {})).toMatchObject({ truncated: false });
    entries(1);
    sql('DELETE FROM audit_log WHERE id = ?', ids().at(-1));
    expect(await app.ok('audit:verify', {})).toMatchObject({ truncated: true });
  });

  it('an empty log is intact', async () => {
    expect(await app.ok('audit:verify', {})).toEqual({ checked: 0, brokenEntryId: null, truncated: false });
  });
});

describe('Settings changes are audited (#193, REL-16)', () => {
  it('records the archive root and other changed settings with before and after, and nothing without a change', async () => {
    const before = (await app.ok('settings:get', {})).settings;
    const target = path.join(app.root, 'neues-archiv');
    fs.mkdirSync(target, { recursive: true });
    await app.ok('settings:update', { archiveRoot: target, privacy: { llmMode: 'confirm' } });

    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'settings.change')!;
    expect(entry).toMatchObject({ actor: 'user', undoable: false });
    expect(entry.before).toEqual({ archiveRoot: before.archiveRoot, 'privacy.llmMode': before.privacy!.llmMode });
    expect(entry.after).toEqual({ archiveRoot: path.resolve(target), 'privacy.llmMode': 'confirm' });

    const count = (await app.ok('audit:list', {})).filter((e) => e.action === 'settings.change').length;
    await app.ok('settings:update', { privacy: { llmMode: 'confirm' } });
    expect((await app.ok('audit:list', {})).filter((e) => e.action === 'settings.change')).toHaveLength(count);
  });
});

describe('Status semantics (#194)', () => {
  const record = (trigger: 'chat' | 'background') =>
    toolCaller(decisionTools(toolDepsOf(app)), { ...emptyToolContext(), trigger })('record_decision', {
      text: 'Wir nehmen das Angebot von Müller',
      topic: 'Dach',
      decidedAt: '2026-09-01',
      participants: ['Anna'],
    });

  it('a decision the user stated is active; what a background run records unreviewed is unclear', async () => {
    await record('chat');
    expect((await app.ok('decisions:list', {}))[0]!.status).toBe('active');
  });

  it('an unclear decision does not count as valid: it replaces nothing, is not checked, and the user can confirm it', async () => {
    await record('background');
    const [unclear] = await app.ok('decisions:list', {});
    expect(unclear!.status).toBe('unclear');
    expect(await app.ok('contradictions:list', {})).toHaveLength(0);

    const older = await create('Wir nehmen das Angebot von Schulz.', { topic: 'Dach 2' });
    const refused = await app.call('decisions:supersede', { oldDecisionId: older.id, newDecisionId: unclear!.id, confirmed: true });
    expect(refused.ok).toBe(false);

    const confirmed = await app.ok('decisions:update', { id: unclear!.id, patch: { status: 'confirmed' } });
    expect(confirmed.status).toBe('confirmed');
  });

  it('completing a draft in the form confirms it, the chat completes it as asserted', async () => {
    const draft = await create('Wir nehmen das Angebot von Müller.', { asDraft: true });
    expect(draft.status).toBe('draft');
    const confirmed = await app.ok('decisions:update', { id: draft.id, patch: { status: 'confirmed', asDraft: false } });
    expect(confirmed.status).toBe('confirmed');
    const other = await create('Wir nehmen das Angebot von Schulz.', { asDraft: true, topic: 'Keller', decidedAt: null });
    expect((await app.ok('decisions:update', { id: other.id, patch: { decidedAt: '2026-09-01' } })).status).toBe('active');
  });
});
