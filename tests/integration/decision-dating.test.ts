import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

// #168: undated decisions are dated by their source documents – never by the day they were captured
let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  // a refused key fails every LLM request at once; an outage would re-queue the analysis for minutes
  app.llm.status = 401;
});
afterEach(async () => {
  await app.cleanup();
});

// saving queues the contradiction check as a job: wait for it
const decision = async (decisionText: string, decidedAt: string | null, sourceIds: string[] = []) => {
  const saved = await app.ok('decisions:create', {
    title: decisionText.slice(0, 40),
    decisionText,
    topic: 'prod-plat',
    decidedAt,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: decidedAt ? [] : ['decidedAt'],
    sourceIds,
    confidence: 0.9,
    asDraft: false,
  });
  await app.services.jobs.whenIdle();
  return saved;
};

async function documentDated(documentDate: string): Promise<string> {
  const imp = await app.ok('documents:import', { paths: [app.file('in/protokoll.txt', 'Protokoll der Sitzung')] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  app.services.ctx.database.sqlite.prepare('UPDATE documents SET document_date = ? WHERE id = ?').run(documentDate, id);
  return id;
}

const supersedeProposals = () => app.services.actions.list('proposed').filter((a) => a.actionType === 'supersede_decision');

describe('Timeline: undated decisions', () => {
  it('takes the date of a dated source document and says so', async () => {
    const doc = await documentDated('2024-05-03');
    const d = await decision('Wir stellen auf Quartalsberichte um.', null, [doc]);

    const entry = (await app.ok('timeline:get', {})).find((e) => e.id === `dec:${d.id}`)!;
    expect(entry.date).toBe('2024-05-03');
    expect(entry.title).toContain('Datum laut Quelldokument');
    expect(entry.undated).toBeUndefined();
  });

  it('without any known date it is marked undated and left out of a date range', async () => {
    const d = await decision('Wir stellen auf Quartalsberichte um.', null);

    const entry = (await app.ok('timeline:get', {})).find((e) => e.id === `dec:${d.id}`)!;
    expect(entry.undated).toBe(true);
    expect(entry.title).not.toContain('erfasst an diesem Tag');
    const ranged = await app.ok('timeline:get', { from: '2000-01-01' });
    expect(ranged.some((e) => e.id === `dec:${d.id}`)).toBe(false);
  });
});

describe('Contradictions: order only from known dates', () => {
  it('an undated decision gets no guessed direction: no supersede proposal, the order is called unknown', async () => {
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', null);

    const [c] = await app.ok('contradictions:list', {});
    expect(c).toBeDefined();
    expect(c!.description).toContain('ist unbekannt');
    expect(supersedeProposals()).toHaveLength(0);
  });

  it('the source document date orders an otherwise undated decision', async () => {
    const doc = await documentDated('2026-03-01');
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', null, [doc]);

    const [p] = supersedeProposals();
    expect(p?.proposedParameters).toMatchObject({ oldDecisionId: older.id, newDecisionId: newer.id });
    expect((await app.ok('contradictions:list', {}))[0]!.description).toContain('2026-03-01 laut Quelldokument');
  });

  it('a later decision captured earlier is still the newer one', async () => {
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');

    expect(supersedeProposals()[0]?.proposedParameters).toMatchObject({ oldDecisionId: older.id, newDecisionId: newer.id });
  });

  it('replacing a decision by hand settles the contradiction of the pair', async () => {
    const a = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const b = await decision('Wir machen mit prod-plat vorerst nicht weiter.', null);

    await app.ok('decisions:supersede', { oldDecisionId: a.id, newDecisionId: b.id, confirmed: true });

    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('resolved');
  });
});
