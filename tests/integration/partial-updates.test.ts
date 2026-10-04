import { DecisionPatch, OpenItemPatch } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => {
  await app.cleanup();
});

/** Comparable view of a record: everything except the timestamp an update necessarily touches. */
const withoutUpdatedAt = <T extends { updatedAt: string }>({ updatedAt: _u, ...rest }: T) => rest;
const decisionFields = withoutUpdatedAt;
const openItemFields = withoutUpdatedAt;

const fullDecision = () =>
  app.ok('decisions:create', {
    title: 'Postgres',
    decisionText: 'Wir nutzen Postgres.',
    decidedAt: '2026-09-01',
    topic: 'Datenbank',
    project: 'Plattform',
    participants: ['Anna', 'Ben'],
    rationale: 'Bewährt',
    consequences: 'Migration nötig',
    alternatives: ['MySQL', 'SQLite'],
    validFrom: '2026-09-01',
    validUntil: '2027-09-01',
    sourceIds: ['src-1'],
    confidence: 0.7,
  });

const fullOpenItem = async () => {
  const item = await app.ok('openItems:create', {
    title: 'Angebot einholen',
    description: 'Drei Angebote vergleichen',
    topic: 'Heizung',
    project: 'Haus',
    responsible: 'Anna',
    dueAt: '2026-11-01',
    priority: 'high',
    confidence: 0.6,
  });
  return app.ok('openItems:update', { id: item.id, patch: { status: 'waiting' } });
};

async function latestUndoable(action: string) {
  const entry = (await app.ok('audit:list', { limit: 50, onlyUndoable: true })).find((e) => e.action === action && !e.undoneAt);
  if (!entry) throw new Error(`no undoable ${action}`);
  return entry;
}

describe('patch schemas carry no defaults', () => {
  it('parsing a partial patch yields only the given fields', () => {
    expect(DecisionPatch.parse({ title: 'Neu' })).toEqual({ title: 'Neu' });
    expect(OpenItemPatch.parse({ title: 'Neu' })).toEqual({ title: 'Neu' });
  });

  it('only non-critical statuses are accepted', () => {
    for (const status of ['draft', 'confirmed', 'active', 'unclear']) expect(DecisionPatch.safeParse({ status }).success).toBe(true);
    for (const status of ['superseded', 'revoked']) expect(DecisionPatch.safeParse({ status }).success).toBe(false);
    for (const status of ['open', 'waiting', 'blocked']) expect(OpenItemPatch.safeParse({ status }).success).toBe(true);
    for (const status of ['resolved', 'dismissed']) expect(OpenItemPatch.safeParse({ status }).success).toBe(false);
  });
});

describe('partial updates keep all other fields', () => {
  it('decision: changing the title keeps participants, alternatives, sources and the rest', async () => {
    const before = await fullDecision();
    const after = await app.ok('decisions:update', { id: before.id, patch: { title: 'Neu' } });
    expect(decisionFields(after)).toEqual({ ...decisionFields(before), title: 'Neu' });
  });

  it('decision: every single field changes only itself', async () => {
    const before = await fullDecision();
    const after = await app.ok('decisions:update', { id: before.id, patch: { rationale: 'Erprobt' } });
    expect(decisionFields(after)).toEqual({ ...decisionFields(before), rationale: 'Erprobt' });
    const again = await app.ok('decisions:update', { id: before.id, patch: { alternatives: ['Oracle'] } });
    expect(decisionFields(again)).toEqual({ ...decisionFields(after), alternatives: ['Oracle'] });
  });

  it('decision: an unrelated edit keeps a legacy topic named like the project', async () => {
    const created = await fullDecision();
    const topic = app.services.graph.ensureEntity({ type: 'topic', name: 'Plattform' });
    app.services.database.sqlite.prepare('UPDATE decisions SET topic_id = ? WHERE id = ?').run(topic.id, created.id);
    const before = await app.ok('decisions:get', { id: created.id });

    const after = await app.ok('decisions:update', { id: before.id, patch: { rationale: 'Erprobt' } });

    expect(decisionFields(after)).toEqual({ ...decisionFields(before), rationale: 'Erprobt' });
    expect(after.topicId).toBe(topic.id);
  });

  it('open item: changing the title keeps priority, status, responsible, due date and the rest', async () => {
    const before = await fullOpenItem();
    expect(before.priority).toBe('high');
    const after = await app.ok('openItems:update', { id: before.id, patch: { title: 'Zwei Angebote einholen' } });
    expect(openItemFields(after)).toEqual({ ...openItemFields(before), title: 'Zwei Angebote einholen' });
  });
});

describe('status changes via update', () => {
  it('decision: switching between non-critical statuses works', async () => {
    const d = await fullDecision();
    expect((await app.ok('decisions:update', { id: d.id, patch: { status: 'draft' } })).status).toBe('draft');
    expect((await app.ok('decisions:update', { id: d.id, patch: { status: 'active' } })).status).toBe('active');
  });

  it('decision: superseded and revoked are rejected by update and stay unchanged', async () => {
    const d = await fullDecision();
    for (const status of ['superseded', 'revoked'] as const) {
      const res = await app.call('decisions:update', { id: d.id, patch: { status } as unknown as DecisionPatch });
      expect(res.ok).toBe(false);
    }
    // internal callers are guarded too
    expect(() => app.services.decisions.update(d.id, { patch: { status: 'revoked' } as unknown as DecisionPatch })).toThrow(/Bestätigung/);
    expect((await app.ok('decisions:get', { id: d.id })).status).toBe('active');
  });

  it('decision: revoke needs confirmation, leaves an undo entry, and a revoked decision cannot be reactivated by editing', async () => {
    const d = await fullDecision();
    const noConfirm = await app.call('decisions:revoke', { id: d.id, confirmed: false as unknown as true });
    expect(noConfirm.ok).toBe(false);

    const revoked = await app.ok('decisions:revoke', { id: d.id, confirmed: true });
    expect(revoked.status).toBe('revoked');
    expect((await app.ok('audit:undo', { auditId: (await latestUndoable('decision.revoke')).id })).undone).toBe(true);
    expect((await app.ok('decisions:get', { id: d.id })).status).toBe('active');

    await app.ok('decisions:revoke', { id: d.id, confirmed: true });
    // editing other fields is fine, the status stays
    const edited = await app.ok('decisions:update', { id: d.id, patch: { rationale: 'Nachtrag' } });
    expect(edited).toMatchObject({ status: 'revoked', rationale: 'Nachtrag' });

    const reactivate = await app.call('decisions:update', { id: d.id, patch: { status: 'active' } });
    expect(reactivate.ok).toBe(false);
    if (!reactivate.ok) expect(reactivate.error.message).toMatch(/Änderungsprotokoll/);
    expect((await app.ok('decisions:get', { id: d.id })).status).toBe('revoked');
  });

  it('decision: supersede needs confirmation, links both decisions and can be undone', async () => {
    const older = await fullDecision();
    const newer = await app.ok('decisions:create', {
      decisionText: 'Wir nutzen SQLite.',
      decidedAt: '2026-10-01',
      topic: 'Datenbank',
      participants: ['Anna'],
    });
    const noConfirm = await app.call('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: false as unknown as true });
    expect(noConfirm.ok).toBe(false);

    const out = await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });
    expect(out.old.status).toBe('superseded');
    expect(out.new.supersedesDecisionId).toBe(older.id);

    expect((await app.ok('audit:undo', { auditId: (await latestUndoable('decision.supersede')).id })).undone).toBe(true);
    expect((await app.ok('decisions:get', { id: older.id })).status).toBe('active');
    expect((await app.ok('decisions:get', { id: newer.id })).supersedesDecisionId).toBeNull();
  });

  it('open item: open/waiting/blocked via update, closing only via the confirmed close', async () => {
    const item = await fullOpenItem();
    expect((await app.ok('openItems:update', { id: item.id, patch: { status: 'blocked' } })).status).toBe('blocked');
    for (const status of ['resolved', 'dismissed'] as const) {
      const res = await app.call('openItems:update', { id: item.id, patch: { status } as unknown as OpenItemPatch });
      expect(res.ok).toBe(false);
    }
    expect(() => app.services.openItems.update(item.id, { patch: { status: 'resolved' } as unknown as OpenItemPatch })).toThrow(/Bestätigung/);
    expect(app.services.openItems.get(item.id).status).toBe('blocked');

    await app.ok('openItems:close', { id: item.id, status: 'resolved', confirmed: true });
    const reopen = await app.call('openItems:update', { id: item.id, patch: { status: 'open' } });
    expect(reopen.ok).toBe(false);
    // other fields of a closed item remain editable
    expect((await app.ok('openItems:update', { id: item.id, patch: { description: 'Erledigt mit Firma X' } })).status).toBe('resolved');
  });
});

describe('unknown fields', () => {
  it('deselecting „unbekannt“ removes the field from unknownFields', async () => {
    const d = await app.ok('decisions:create', {
      decisionText: 'Wir verschieben den Umzug.',
      topic: 'Umzug',
      unknownFields: ['decidedAt', 'participants'],
    });
    expect(d.status).toBe('active');
    expect(d.unknownFields.sort()).toEqual(['decidedAt', 'participants']);

    const updated = await app.ok('decisions:update', { id: d.id, patch: { unknownFields: ['participants'] } });
    expect(updated.unknownFields).toEqual(['participants']);
    expect(updated.missingFields).toEqual(['decidedAt']);

    // a patch without unknownFields keeps them
    expect((await app.ok('decisions:update', { id: d.id, patch: { rationale: 'Kosten' } })).unknownFields).toEqual(['participants']);
  });
});
