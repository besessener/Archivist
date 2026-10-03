import type { DecisionInput } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    topic: 'Datenbank',
    decidedAt: '2026-09-01',
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
    ...over,
  });

const supersede = (oldDecisionId: string, newDecisionId: string) => app.call('decisions:supersede', { oldDecisionId, newDecisionId, confirmed: true });

describe('Supersession chain (#184)', () => {
  it('shows the replacing decision on the old one and in the text the LLM sees', async () => {
    const older = await create('Wir nutzen Postgres.');
    const newer = await create('Wir nutzen SQLite.', { title: 'SQLite statt Postgres' });
    expect((await app.ok('decisions:get', { id: older.id })).supersededBy).toEqual([]);

    await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });

    const old = await app.ok('decisions:get', { id: older.id });
    expect(old.supersededBy).toEqual([{ id: newer.id, title: 'SQLite statt Postgres' }]);
    expect(app.services.decisions.format(old)).toContain('**Ersetzt durch:** SQLite statt Postgres');
    expect(app.services.decisions.format(await app.ok('decisions:get', { id: newer.id }))).not.toContain('Ersetzt durch');
    expect((await app.ok('decisions:list', { status: 'superseded' }))[0]!.supersededBy).toHaveLength(1);

    // undo takes the forward link away again
    const entry = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'decision.supersede')!;
    await app.ok('audit:undo', { auditId: entry.id });
    expect((await app.ok('decisions:get', { id: older.id })).supersededBy).toEqual([]);
  });

  it('only a valid decision may replace another one', async () => {
    const older = await create('Wir nutzen Postgres.');
    const draft = await create('Wir nutzen SQLite.', { asDraft: true });
    const unclear = await create('Wir nutzen MySQL.');
    await app.ok('decisions:update', { id: unclear.id, patch: { status: 'unclear' } });
    const revoked = await create('Wir nutzen Oracle.');
    await app.ok('decisions:revoke', { id: revoked.id, confirmed: true });

    for (const candidate of [draft, unclear, revoked]) {
      const result = await supersede(older.id, candidate.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/gültig oder bestätigt/);
    }
    expect((await app.ok('decisions:get', { id: older.id })).status).toBe('active');

    const confirmed = await create('Wir nutzen DuckDB.');
    await app.ok('decisions:update', { id: confirmed.id, patch: { status: 'confirmed' } });
    expect((await supersede(older.id, confirmed.id)).ok).toBe(true);
  });

  it('a second superseded decision is kept in the relations, the first stays in the column', async () => {
    const a = await create('Wir nutzen Postgres.');
    const b = await create('Wir nutzen MySQL.');
    const newer = await create('Wir nutzen SQLite.', { title: 'SQLite' });

    expect((await supersede(a.id, newer.id)).ok).toBe(true);
    expect((await supersede(b.id, newer.id)).ok).toBe(true);

    const after = await app.ok('decisions:get', { id: newer.id });
    expect(after.supersedesDecisionId).toBe(a.id);
    const targets = app.services.graph.relationsOf(newer.id, { types: ['supersedes'] }).map((r) => r.targetEntityId);
    expect(targets.sort()).toEqual([a.id, b.id].sort());
    expect((await app.ok('decisions:get', { id: b.id })).supersededBy).toEqual([{ id: newer.id, title: 'SQLite' }]);

    // repeating the pair changes nothing; undoing the second leaves the first intact
    const before = (await app.ok('audit:list', {})).length;
    expect((await supersede(b.id, newer.id)).ok).toBe(true);
    expect((await app.ok('audit:list', {})).length).toBe(before);
    const second = (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === 'decision.supersede')!;
    await app.ok('audit:undo', { auditId: second.id });
    expect((await app.ok('decisions:get', { id: b.id })).status).toBe('active');
    expect((await app.ok('decisions:get', { id: a.id })).supersededBy).toHaveLength(1);
    expect((await app.ok('decisions:get', { id: newer.id })).supersedesDecisionId).toBe(a.id);
  });

  it('the timeline keeps the newest entries when it is cut off at a limit', async () => {
    for (const day of ['01', '02', '03']) await create(`Entscheidung vom ${day}.`, { decidedAt: `2026-09-${day}`, topic: `Thema ${day}` });
    const entries = await app.ok('timeline:get', { limit: 2 });
    expect(entries.map((e) => e.date)).toEqual(['2026-09-02', '2026-09-03']);
  });
});
