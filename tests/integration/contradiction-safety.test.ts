import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documents } from '../../packages/core/src/db/schema';
import { archived } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const verdict = (isContradiction: boolean) => () => ({ isContradiction, confidence: 0.9, description: 'Die Beträge widersprechen sich.' });
const llmQuestions = () => app.llm.calls.filter((call) => call.schema === 'ContradictionProposal').length;

const decision = (decisionText: string, decidedAt: string, extra: Record<string, unknown> = {}) =>
  app.ok('decisions:create', {
    title: decisionText.slice(0, 40),
    decisionText,
    topic: 'prod-plat',
    decidedAt,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
    ...extra,
  });

const contradictionsWith = (status: string) => app.services.contradictions.list().filter((c) => c.status === status);
const goOffline = () => app.services.settings.update({ privacy: { llmMode: 'confirm' } });
const goOnline = () => app.services.settings.update({ privacy: { llmMode: 'auto' } });

describe('Privacy of the contradiction check', () => {
  it('never sends a pair to the LLM when a source document of one decision is excluded', async () => {
    app.llm.on('ContradictionProposal', verdict(true));
    const secret = await archived(app, { name: 'geheim.txt', content: 'Geheim', folder: 'Privat/misc' });
    app.services.database.db.update(documents).set({ llmStatus: 'excluded' }).where(eq(documents.id, secret)).run();

    await decision('Das Budget beträgt 5000 Euro.', '2026-01-10', { sourceIds: [secret] });
    await decision('Das Budget beträgt 8000 Euro.', '2026-03-01');
    await app.services.contradictions.scanAll();

    expect(llmQuestions()).toBe(0);
    expect(app.services.contradictions.list()).toHaveLength(0);
  });

  it('still asks the LLM when the source document may be shared', async () => {
    app.llm.on('ContradictionProposal', verdict(true));
    const open = await archived(app, { name: 'offen.txt', content: 'Offen', folder: 'Privat/misc' });

    await decision('Das Budget beträgt 5000 Euro.', '2026-01-10', { sourceIds: [open] });
    await decision('Das Budget beträgt 8000 Euro.', '2026-03-01');

    expect(llmQuestions()).toBe(1);
    expect(contradictionsWith('detected')).toHaveLength(1);
  });

  it('keeps the lexical result for a pair with an excluded source', async () => {
    const secret = await archived(app, { name: 'geheim.txt', content: 'Geheim', folder: 'Privat/misc' });
    app.services.database.db.update(documents).set({ llmStatus: 'excluded' }).where(eq(documents.id, secret)).run();

    await decision('Wir führen prod-plat weiter.', '2026-01-10', { sourceIds: [secret] });
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    expect(llmQuestions()).toBe(0);
    expect(contradictionsWith('detected')).toHaveLength(1);
  });
});

describe('Immediate check of a decision', () => {
  it('asks the LLM at most ten times, however many decisions share the topic', async () => {
    app.llm.on('ContradictionProposal', verdict(false));
    for (let amount = 1; amount <= 13; amount += 1) await decision(`Das Budget beträgt ${amount}000 Euro.`, `2026-01-${String(amount).padStart(2, '0')}`);
    const before = llmQuestions();

    await decision('Das Budget beträgt 99000 Euro.', '2026-02-01');

    expect(llmQuestions() - before).toBe(10);
  });

  it('returns only newly detected contradictions, not a pair that was closed before', async () => {
    goOffline();
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [found] = contradictionsWith('detected');
    await app.ok('contradictions:resolve', { id: found!.id, resolution: 'false_positive', confirmed: true });

    expect(await app.services.contradictions.checkDecision(newer.id)).toEqual([]);
    expect(contradictionsWith('false_positive')).toHaveLength(1);
  });
});

describe('Closing by the LLM veto', () => {
  const relationOfPair = (newerId: string) => app.services.graph.relationsOf(newerId).find((r) => r.relationType === 'contradicts')!;

  it('rejects the „widerspricht“ relation as the system, not as the user', async () => {
    goOffline();
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    goOnline();
    app.llm.on('ContradictionProposal', verdict(false));

    await app.services.consistency.run({ trigger: 'test' });

    expect(contradictionsWith('false_positive')).toHaveLength(1);
    expect(relationOfPair(newer.id)).toMatchObject({ status: 'rejected', resolvedByUser: false });
  });

  it('rejects the relation as the user when the user marks the false alarm', async () => {
    goOffline();
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [found] = contradictionsWith('detected');

    await app.ok('contradictions:resolve', { id: found!.id, resolution: 'false_positive', confirmed: true });

    expect(relationOfPair(newer.id)).toMatchObject({ status: 'rejected', resolvedByUser: true });
  });

  it('does not close a contradiction the user acknowledged', async () => {
    goOffline();
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [found] = contradictionsWith('detected');
    await app.ok('contradictions:resolve', { id: found!.id, resolution: 'acknowledged', confirmed: true });
    goOnline();
    app.llm.on('ContradictionProposal', verdict(false));

    await app.services.consistency.run({ trigger: 'test' });

    expect(contradictionsWith('acknowledged')).toHaveLength(1);
    expect(contradictionsWith('false_positive')).toHaveLength(0);
  });
});

describe('Reopening after an undone supersede', () => {
  const undoSupersede = async () => {
    const entry = app.services.audit.list({ limit: 50 }).find((e) => e.action === 'decision.supersede')!;
    await app.ok('audit:undo', { auditId: entry.id });
  };

  it('keeps the contradiction row (id, creation time) and its single insight', async () => {
    goOffline();
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [before] = contradictionsWith('detected');
    await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });

    await undoSupersede();

    const [after] = app.services.contradictions.list();
    expect(app.services.contradictions.list()).toHaveLength(1);
    expect(after).toMatchObject({ id: before!.id, createdAt: before!.createdAt, status: 'detected', resolvedAt: null });
    expect(app.services.insights.list({ status: 'open' }).filter((i) => i.kind === 'contradiction')).toHaveLength(1);
  });

  it('leaves a contradiction the user resolved by hand, without superseding, resolved', async () => {
    goOffline();
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [found] = contradictionsWith('detected');
    await app.ok('contradictions:resolve', { id: found!.id, resolution: 'resolved', confirmed: true });
    await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });

    await undoSupersede();

    expect(contradictionsWith('resolved')).toHaveLength(1);
    expect(contradictionsWith('detected')).toHaveLength(0);
  });
});
