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

const auditEntry = async (action: string) => (await app.ok('audit:list', { onlyUndoable: true })).find((e) => e.action === action)!;

describe('Deleting a decision created in error (#183)', () => {
  it('removes a draft everywhere and brings it back exactly with the undo entry', async () => {
    const draft = await create('Wir nehmen das Angebot von Müller.', { asDraft: true, participants: ['Anna'], project: 'Hausbau' });
    const person = app.services.graph.ensureEntity({ type: 'person', name: 'Berta Klein' });
    app.services.graph.link(
      { sourceId: person.id, targetId: draft.id, relationType: 'participated_in' },
      { confidence: 0.7, status: 'confirmed', resolvedByUser: true },
    );
    const relationsBefore = app.services.graph
      .getDetail(draft.id)
      .relations.map((r) => r.id)
      .sort();
    await app.services.decisions.reindex(draft.id);

    const { auditId } = await app.ok('decisions:delete', { id: draft.id, confirmed: true });

    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect(app.services.graph.getEntity(draft.id)).toBeUndefined();
    expect((await app.ok('search:global', { query: 'Angebot von Müller', limit: 5 })).some((h) => h.id === draft.id)).toBe(false);
    expect((await app.ok('timeline:get', {})).some((e) => e.id === `dec:${draft.id}`)).toBe(false);
    const entry = await auditEntry('decision.delete');
    expect(entry).toMatchObject({ id: auditId, undoable: true, entityIds: [draft.id], entities: [{ id: draft.id, title: draft.title }] });

    const result = await app.ok('audit:undo', { auditId });
    expect(result).toMatchObject({ undone: true, conflicts: [], message: 'Entscheidung wiederhergestellt.' });
    expect(await app.ok('decisions:list', {})).toEqual([draft]);
    expect(
      app.services.graph
        .getDetail(draft.id)
        .relations.map((r) => r.id)
        .sort(),
    ).toEqual(relationsBefore);
    expect((await app.ok('audit:undo', { auditId })).undone).toBe(false);
  });

  it('needs the confirmation and only deletes drafts and unclear decisions', async () => {
    const draft = await create('Entwurf ohne Datum', { asDraft: true });
    expect((await app.call('decisions:delete', { id: draft.id, confirmed: false as unknown as true })).ok).toBe(false);
    expect(await app.ok('decisions:list', {})).toHaveLength(1);

    const valid = await create('Gültige Entscheidung', { topic: 'Dämmung' });
    const refused = await app.call('decisions:delete', { id: valid.id, confirmed: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/widerrufst/);

    const unclear = await create('Unklare Entscheidung', { topic: 'Fenster' });
    await app.ok('decisions:update', { id: unclear.id, patch: { status: 'unclear' } });
    expect((await app.call('decisions:delete', { id: unclear.id, confirmed: true })).ok).toBe(true);
    expect((await app.ok('decisions:list', {})).map((d) => d.id).sort()).toEqual([draft.id, valid.id].sort());
  });

  it('a decision that another one replaces is not deleted', async () => {
    const older = await create('Alte Entscheidung', { topic: 'Heizung' });
    const newer = await create('Neue Entscheidung', { topic: 'Heizung' });
    await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });
    app.services.database.sqlite.prepare('UPDATE decisions SET status = ? WHERE id = ?').run('draft', older.id);
    const result = await app.call('decisions:delete', { id: older.id, confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/ersetzt diese/);
  });

  it('restores the draft even when its topic was removed in the meantime, and says so', async () => {
    const draft = await create('Entwurf zum Thema', { asDraft: true, topic: 'Altes Thema', participants: [] });
    const { auditId } = await app.ok('decisions:delete', { id: draft.id, confirmed: true });
    app.services.graph.removeNode(draft.topicId!);
    expect((await app.ok('audit:undo', { auditId })).undone).toBe(true);
    expect(await app.ok('decisions:get', { id: draft.id })).toMatchObject({ topicId: null, topicName: null, status: 'draft' });
  });
});

describe('Revoked and unclear decisions are recognisable (#183)', () => {
  it('marks them in the timeline titles', async () => {
    const revoked = await create('Wir streichen das Dach rot.', { topic: 'Farbe' });
    await app.ok('decisions:revoke', { id: revoked.id, confirmed: true });
    const unclear = await create('Wir streichen die Tür grün.', { topic: 'Tür' });
    await app.ok('decisions:update', { id: unclear.id, patch: { status: 'unclear' } });
    const valid = await create('Wir streichen den Zaun blau.', { topic: 'Zaun' });

    const titles = new Map((await app.ok('timeline:get', {})).map((e) => [e.id, e.title]));
    expect(titles.get(`dec:${revoked.id}`)).toMatch(/^Entscheidung \(widerrufen\): /);
    expect(titles.get(`dec:${unclear.id}`)).toMatch(/^Entscheidung \(unklar\): /);
    expect(titles.get(`dec:${valid.id}`)).toMatch(/^Entscheidung: /);
  });

  it('names the status in the answer without an LLM', async () => {
    const revoked = await create('Wir pausieren prod-plat.', { title: 'prod-plat pausiert', topic: 'prod-plat' });
    await app.ok('decisions:revoke', { id: revoked.id, confirmed: true });
    app.llm.down = true;
    const reply = await app.ok('chat:send', { text: 'Wann haben wir prod-plat pausiert?' });
    expect(reply.assistantMessage.content).toMatch(/lokale Trefferliste/);
    expect(reply.assistantMessage.content).toMatch(/\*\*1\. prod-plat pausiert\*\* \(decision, entschieden am 2026-09-01, Widerrufen\)/);
  });
});
