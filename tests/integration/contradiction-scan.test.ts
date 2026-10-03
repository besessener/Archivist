import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const verdict = (isContradiction: boolean) => () => ({
  isContradiction,
  confidence: 0.9,
  description: isContradiction ? 'Die Beträge widersprechen sich.' : 'Kein Widerspruch.',
});
const llmQuestions = (target: TestApp = app) => target.llm.calls.filter((call) => call.schema === 'ContradictionProposal').length;

const decision = (decisionText: string, decidedAt: string | null, extra: Record<string, unknown> = {}) =>
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

// no background use of the LLM (privacy mode „vorher fragen“), without the circuit breaker of an unreachable endpoint
const goOffline = () => app.services.settings.update({ privacy: { llmMode: 'confirm' } });
const goOnline = () => app.services.settings.update({ privacy: { llmMode: 'auto' } });

const contradictionsWith = (status: string) => app.services.contradictions.list().filter((c) => c.status === status);
const openInsights = (kind: string) => app.services.insights.list('open').filter((i) => i.kind === kind);

describe('Contradiction scan with an LLM (#179)', () => {
  it('sends pairs without polarity or option to the LLM, so budgets are checked too', async () => {
    app.llm.on('ContradictionProposal', verdict(true));
    await decision('Das Budget beträgt 5000 Euro.', '2026-01-10');
    await decision('Das Budget beträgt 8000 Euro.', '2026-03-01');

    expect(contradictionsWith('detected')).toHaveLength(1);
    expect(llmQuestions()).toBe(1);
  });

  it('does not judge such a pair without an LLM', async () => {
    app.llm.down = true;
    await decision('Das Budget beträgt 5000 Euro.', '2026-01-10');
    await decision('Das Budget beträgt 8000 Euro.', '2026-03-01');

    expect(app.services.contradictions.list()).toHaveLength(0);
  });

  it('finds the opposite of a negated decision without an LLM', async () => {
    app.llm.down = true;
    await decision('Wir wollen das Projekt prod-plat weiterführen.', '2026-01-10');
    await decision('Wir wollen das Projekt prod-plat nicht weiterführen.', '2026-03-01');

    expect(contradictionsWith('detected')).toHaveLength(1);
  });

  it('compares decisions of different topics in the same project', async () => {
    app.llm.down = true;
    await decision('Wir führen das Projekt weiter.', '2026-01-10', { topic: 'Planung', project: 'Haus' });
    await decision('Wir stoppen das Projekt.', '2026-03-01', { topic: 'Finanzen', project: 'Haus' });
    await decision('Wir stoppen das Projekt.', '2026-03-02', { topic: 'Finanzen', project: 'Garten' });

    const [found] = contradictionsWith('detected');
    expect(contradictionsWith('detected')).toHaveLength(1);
    expect(found!.excerpts).toHaveLength(2);
  });

  it('asks at most once per pair of texts: scans and edits that keep the texts reuse the stored verdict', async () => {
    app.llm.on('ContradictionProposal', verdict(false));
    const first = await decision('Das Budget beträgt 5000 Euro.', '2026-01-10');
    await decision('Das Budget beträgt 8000 Euro.', '2026-03-01');

    await app.services.consistency.run({ trigger: 'test' });
    await app.ok('decisions:update', { id: first.id, patch: { rationale: 'Weil es so ist.' } });
    await app.services.consistency.run({ trigger: 'test' });

    expect(llmQuestions()).toBe(1);
    expect(app.services.contradictions.list()).toHaveLength(0);
  });
});

describe('Vetoes of the LLM survive a restart (#180)', () => {
  it('a rejected pair is not sent to the LLM again after the app was restarted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-veto-'));
    const first = await createTestApp({ dataRoot: root });
    try {
      first.llm.on('ContradictionProposal', verdict(false));
      const create = (decisionText: string, decidedAt: string) =>
        first.ok('decisions:create', {
          decisionText,
          title: decisionText,
          topic: 'prod-plat',
          decidedAt,
          participants: ['Anna'],
          alternatives: [],
          unknownFields: [],
          sourceIds: [],
          confidence: 0.9,
          asDraft: false,
        });
      await create('Wir führen prod-plat weiter.', '2026-01-10');
      await create('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
      expect(llmQuestions(first)).toBe(1);
      await first.services.shutdown();

      const second = await createTestApp({ dataRoot: root });
      try {
        second.llm.on('ContradictionProposal', verdict(false));
        await second.services.consistency.run({ trigger: 'test' });

        expect(llmQuestions(second)).toBe(0);
        expect(second.services.contradictions.list()).toHaveLength(0);
      } finally {
        await second.services.shutdown();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a pair found while offline is put to the LLM later; its veto closes the contradiction as a false alarm', async () => {
    goOffline();
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    expect(contradictionsWith('detected')).toHaveLength(1);
    goOnline();
    app.llm.on('ContradictionProposal', verdict(false));

    await app.services.consistency.run({ trigger: 'test' });

    expect(contradictionsWith('false_positive')).toHaveLength(1);
    expect(openInsights('contradiction')).toHaveLength(0);
    expect(llmQuestions()).toBe(1);
  });

  it('a pair found while offline stays when the LLM confirms it, and is not asked about again', async () => {
    goOffline();
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    goOnline();
    app.llm.on('ContradictionProposal', verdict(true));

    await app.services.consistency.run({ trigger: 'test' });
    await app.services.consistency.run({ trigger: 'test' });

    expect(contradictionsWith('detected')).toHaveLength(1);
    expect(llmQuestions()).toBe(1);
  });
});

describe('Cancelling the contradiction scan (#180)', () => {
  it('the archive check passes its signal on: no further pair is sent to the LLM after the cancel', async () => {
    const controller = new AbortController();
    app.llm.on('ContradictionProposal', () => {
      controller.abort();
      return { isContradiction: false, confidence: 0.9, description: '' };
    });
    await decision('Das Budget beträgt 5000 Euro.', '2026-01-10');
    await decision('Das Budget beträgt 6000 Euro.', '2026-02-10');
    await decision('Das Budget beträgt 7000 Euro.', '2026-03-10');
    const before = llmQuestions();

    await expect(app.services.consistency.run({ trigger: 'test', signal: controller.signal })).rejects.toThrow();

    expect(llmQuestions() - before).toBeLessThanOrEqual(1);
  });
});

describe('Undoing a supersede (#182)', () => {
  it('raises the resolved contradiction of the pair again', async () => {
    app.llm.down = true;
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });
    expect(contradictionsWith('resolved')).toHaveLength(1);
    expect(openInsights('contradiction')).toHaveLength(0);
    const entry = app.services.audit.list({ limit: 50 }).find((e) => e.action === 'decision.supersede')!;

    const undone = await app.ok('audit:undo', { auditId: entry.id });

    expect(undone.undone).toBe(true);
    expect(contradictionsWith('detected')).toHaveLength(1);
    expect(contradictionsWith('resolved')).toHaveLength(0);
    expect(openInsights('contradiction')).toHaveLength(1);
    expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'supersede_decision')).toHaveLength(1);
  });

  it('leaves a contradiction the user marked as a false alarm alone', async () => {
    app.llm.down = true;
    const older = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const newer = await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [found] = contradictionsWith('detected');
    await app.ok('contradictions:resolve', { id: found!.id, resolution: 'false_positive', confirmed: true });
    await app.ok('decisions:supersede', { oldDecisionId: older.id, newDecisionId: newer.id, confirmed: true });
    const entry = app.services.audit.list({ limit: 50 }).find((e) => e.action === 'decision.supersede')!;

    await app.ok('audit:undo', { auditId: entry.id });

    expect(contradictionsWith('false_positive')).toHaveLength(1);
    expect(contradictionsWith('detected')).toHaveLength(0);
  });
});

describe('Validity of decisions (#185)', () => {
  it('flags an active decision whose validity has ended, once, and not one that is still valid', async () => {
    app.llm.down = true;
    await decision('Der Mietvertrag läuft über das Angebot A.', '2019-01-10', { validUntil: '2020-01-01' });
    await decision('Die Heizung wird im Winter gewartet.', '2026-01-10', { validUntil: '2999-01-01' });
    await decision('Das Dach wird saniert.', '2026-01-10');

    await app.services.consistency.run({ trigger: 'test' });
    await app.services.consistency.run({ trigger: 'test' });

    const expired = openInsights('decision_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.title).toContain('Gültigkeit abgelaufen');
    expect(expired[0]!.explanation).toContain('2020-01-01');
  });

  it('closes the hint when the validity is extended', async () => {
    app.llm.down = true;
    const expired = await decision('Der Mietvertrag läuft über das Angebot A.', '2019-01-10', { validUntil: '2020-01-01' });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('decision_expired')).toHaveLength(1);

    await app.ok('decisions:update', { id: expired.id, patch: { validUntil: '2999-01-01' } });
    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('decision_expired')).toHaveLength(0);
  });

  it('shows the validity window in the text the LLM sees', async () => {
    const dated = await decision('Das Dach wird saniert.', '2026-01-10', { validFrom: '2026-02-01', validUntil: '2026-12-31' });
    const open = await decision('Der Zaun wird gestrichen.', '2026-01-10');

    expect(app.services.decisions.format(dated)).toContain('**Gültig:** ab 2026-02-01 bis 2026-12-31');
    expect(app.services.decisions.format(open)).not.toContain('Gültig');
  });
});

describe('„Möglicherweise überholt“ needs a common subject (#186)', () => {
  it('is not raised for decisions on one topic that have nothing in common', async () => {
    app.llm.down = true;
    await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    await decision('Das Protokoll schreibt Anna.', '2026-03-01');

    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('possibly_superseded')).toHaveLength(0);
  });

  it('is raised for decisions that share a content word, also when they only belong to a project', async () => {
    app.llm.down = true;
    await decision('Das Meeting findet dienstags statt.', '2026-01-10', { topic: null, project: 'Verein', unknownFields: ['topic'] });
    await decision('Das Meeting findet donnerstags statt.', '2026-03-01', { topic: null, project: 'Verein', unknownFields: ['topic'] });

    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('possibly_superseded')).toHaveLength(1);
  });

  it.each([
    ['dated', '2026-03-01'],
    ['undated', null],
  ])('flags identical %s decisions as a duplicate', async (_name, decidedAt) => {
    app.llm.down = true;
    const same = { unknownFields: ['decidedAt'] };
    await decision('Das Meeting findet dienstags statt.', decidedAt, same);
    await decision('Das Meeting findet dienstags statt.', decidedAt, same);

    await app.services.consistency.run({ trigger: 'test' });

    const [hint] = openInsights('possibly_superseded');
    expect(openInsights('possibly_superseded')).toHaveLength(1);
    expect(hint!.title).toContain('Doppelte Entscheidung');
    expect(hint!.recommendedActionId).toBeTruthy();
  });
});

describe('Immediate contradiction check (#191)', () => {
  it('also runs for a draft completed afterwards (status confirmed)', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const draft = await decision('Wir machen mit prod-plat vorerst nicht weiter.', null, { asDraft: true, participants: [] });
    expect(draft.status).toBe('draft');
    expect(contradictionsWith('detected')).toHaveLength(0);

    const completed = await app.ok('decisions:update', { id: draft.id, patch: { decidedAt: '2026-03-01', participants: ['Anna'], status: 'confirmed' } });

    expect(completed.status).toBe('confirmed');
    expect(contradictionsWith('detected')).toHaveLength(1);
  });

  it('runs after a decision from a document was approved (record_decision)', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    const proposal = app.services.actions.propose({
      actionType: 'record_decision',
      rationale: 'Beschluss im Dokument.',
      confidence: 0.8,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: {
        title: 'prod-plat pausieren',
        decisionText: 'Wir machen mit prod-plat vorerst nicht weiter.',
        decidedAt: '2026-03-01',
        participants: ['Anna'],
        topic: 'prod-plat',
      },
      label: 'Entscheidung erfassen',
    });

    await app.ok('actions:resolve', { decision: 'approve', actionId: proposal.id, confirmed: true, strongConfirmed: false });

    expect(contradictionsWith('detected')).toHaveLength(1);
  });
});
