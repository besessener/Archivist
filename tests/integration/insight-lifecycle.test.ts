import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const TOPIC = 'Bildungsurlaub 2026';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const row = (id: string) => app.services.documents.getRow(id);
const folderOf = (id: string) => path.posix.dirname(row(id).archiveRelPath!);
const openInsights = (kind?: string) => app.services.insights.list('open').filter((i) => !kind || i.kind === kind);
const actionStatus = (id: string) => app.services.actions.get(id).status;

async function archived(name: string, loc: string, topic: string | null = TOPIC): Promise<string> {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title: name,
    summary: `Zusammenfassung ${name}`,
    mainTopic: topic,
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: loc, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Inhalt von ${name}`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

/** Two documents in the majority folder, one elsewhere: the archive check proposes moving the odd one. */
async function scattered() {
  const a = await archived('Bescheid', 'private/bildungsurlaub/2026');
  const b = await archived('Teilnahme', 'private/bildungsurlaub/2026');
  const odd = await archived('Antrag', 'work/hr/abwesenheiten');
  return { a, b, odd };
}

const relocate = (documentId: string, categoryPath: string) => app.services.archive.relocate([{ documentId, categoryPath }], { confirmed: true });

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

describe('Archive check: withdrawn hints withdraw their action too', () => {
  it('when the cause goes away, the hint disappears and its action becomes "withdrawn" (not "proposed")', async () => {
    const { odd } = await scattered();
    await app.services.consistency.run({ trigger: 'test' });
    const [insight] = openInsights('scattered_documents');
    const actionId = insight!.recommendedActionId!;
    expect(actionStatus(actionId)).toBe('proposed');

    await relocate(odd, 'private/bildungsurlaub/2026'); // the user tidied up by other means
    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('scattered_documents')).toHaveLength(0);
    expect(actionStatus(actionId)).toBe('withdrawn');
    expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents')).toHaveLength(0);
  });

  it('when the distribution changes, the hint replaces its proposal instead of creating a second one', async () => {
    await scattered();
    await app.services.consistency.run({ trigger: 'test' });
    const first = openInsights('scattered_documents')[0]!;

    const extra = await archived('Ticket', 'work/tickets');
    await app.services.consistency.run({ trigger: 'test' });

    const after = openInsights('scattered_documents');
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first.id);
    expect(after[0]!.recommendedActionId).not.toBe(first.recommendedActionId);
    expect(actionStatus(first.recommendedActionId!)).toBe('withdrawn');
    const proposed = app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents');
    expect(proposed.map((a) => a.id)).toEqual([after[0]!.recommendedActionId]);
    expect(JSON.stringify(proposed[0]!.proposedParameters)).toContain(extra);
  });
});

describe('Stable keys: a run closes hints whose cause no longer exists', () => {
  it('missing archive file: the hint disappears as soon as the file is back', async () => {
    const id = await archived('Vertrag', 'work/vertraege');
    const abs = path.join(archiveRoot(), row(id).archiveRelPath!);
    const backup = fs.readFileSync(abs);
    fs.unlinkSync(abs);
    await app.services.consistency.run({ trigger: 'test' });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('misplaced_file').filter((i) => i.title.includes('fehlt'))).toHaveLength(1);

    fs.writeFileSync(abs, backup);
    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('misplaced_file')).toHaveLength(0);
  });

  it('incomplete decision: one hint per decision, even when the missing fields change; complete → closed', async () => {
    const d = await app.ok('decisions:create', {
      title: 'Neues Ticketsystem',
      decisionText: 'Wir nutzen künftig ein neues Ticketsystem.',
      topic: 'Support',
      decidedAt: null,
      participants: [],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('incomplete_decision')).toHaveLength(1);

    await app.ok('decisions:update', { id: d.id, patch: { participants: ['Anna'] } });
    await app.services.consistency.run({ trigger: 'test' });
    const still = openInsights('incomplete_decision');
    expect(still).toHaveLength(1);
    expect(still[0]!.explanation).not.toContain('Beteiligte');

    await app.ok('decisions:update', { id: d.id, patch: { participants: ['Anna'], decidedAt: '2026-03-01' } });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('incomplete_decision')).toHaveLength(0);
    expect((await app.ok('notifications:list', {})).filter((n) => n.type === 'incomplete_decision')).toHaveLength(0);
  });

  it('documents without a topic: a single hint that grows instead of a new one per change', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run({ trigger: 'test' });
    await archived('Zweite lose Notiz', 'work/notizen', null);
    await app.services.consistency.run({ trigger: 'test' });

    const orphan = openInsights('orphan_document');
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.sourceIds).toHaveLength(2);
  });

  it('overdue items: the notification closes when the item is done', async () => {
    const item = await app.ok('openItems:create', {
      title: 'Steuerbescheid prüfen',
      dueAt: '2020-01-01',
      priority: 'normal',
      sourceIds: [],
      confidence: 0.9,
    } as never);
    await app.services.consistency.run({ trigger: 'test' });
    expect((await app.ok('notifications:list', {})).some((n) => n.type === 'open_item_overdue')).toBe(true);

    await app.ok('openItems:close', { id: item.id, status: 'resolved', confirmed: true });
    await app.services.consistency.run({ trigger: 'test' });

    expect((await app.ok('notifications:list', {})).some((n) => n.type === 'open_item_overdue')).toBe(false);
  });
});

describe('Accepting without an action does not hide a problem forever', () => {
  it('if the cause comes back after it was fixed, it is reported again', async () => {
    const id = await archived('Vertrag', 'work/vertraege');
    const abs = path.join(archiveRoot(), row(id).archiveRelPath!);
    const backup = fs.readFileSync(abs);
    fs.unlinkSync(abs);
    await app.services.consistency.run({ trigger: 'test' });
    const missing = openInsights('misplaced_file')[0]!;
    await app.ok('insights:respond', { response: 'accept', id: missing.id, confirmed: true, strongConfirmed: false });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('misplaced_file'), 'just confirmed: not again right away').toHaveLength(0);

    fs.writeFileSync(abs, backup);
    await app.services.consistency.run({ trigger: 'test' });
    fs.unlinkSync(abs);
    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('misplaced_file')).toHaveLength(1);
  });

  it('if new affected objects are added, the confirmed hint reopens', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run({ trigger: 'test' });
    await app.ok('insights:respond', { response: 'accept', id: openInsights('orphan_document')[0]!.id, confirmed: true, strongConfirmed: false });

    await archived('Zweite lose Notiz', 'work/notizen', null);
    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('orphan_document')).toHaveLength(1);
  });

  it('if the cause still exists days after confirming, the hint is reopened', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run({ trigger: 'test' });
    const ins = openInsights('orphan_document')[0]!;
    await app.ok('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('orphan_document')).toHaveLength(0);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    try {
      await app.services.consistency.run({ trigger: 'test' });
    } finally {
      vi.useRealTimers();
    }

    expect(openInsights('orphan_document').map((i) => i.id)).toEqual([ins.id]);
  });

  it('rejected hints stay rejected as long as the cause exists', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run({ trigger: 'test' });
    await app.ok('insights:respond', { response: 'reject', id: openInsights('orphan_document')[0]!.id });
    await app.services.consistency.run({ trigger: 'test' });
    expect(openInsights('orphan_document')).toHaveLength(0);
  });
});

describe('Contradiction, insight and action: one shared lifecycle', () => {
  const contradictionInsight = () => openInsights('contradiction')[0];
  const contradictionNotes = async () => (await app.ok('notifications:list', {})).filter((n) => n.type === 'contradiction');

  it('„Auflösen“ on the contradiction also closes the insight, replace action and notification', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const [c] = await app.ok('contradictions:list', {});
    const ins = contradictionInsight()!;

    await app.ok('contradictions:resolve', { id: c!.id, resolution: 'false_positive', confirmed: true } as never);

    expect(contradictionInsight()).toBeUndefined();
    expect(app.services.insights.get(ins.id).status).toBe('rejected');
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
    expect(await contradictionNotes()).toHaveLength(0);
  });

  it('replacing via the insight resolves the contradiction', async () => {
    app.llm.down = true;
    const a = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    await app.ok('insights:respond', { response: 'accept', id: contradictionInsight()!.id, confirmed: true, strongConfirmed: false });

    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('superseded');
    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('resolved');
    expect(await contradictionNotes()).toHaveLength(0);
  });

  it('rejecting the insight acknowledges the contradiction and closes the notification', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    await app.ok('insights:respond', { response: 'reject', id: contradictionInsight()!.id });

    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('acknowledged');
    expect(await contradictionNotes()).toHaveLength(0);
  });

  it('no additional „möglicherweise überholt“ proposal for a pair with a contradiction', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('contradiction')).toHaveLength(1);
    expect(openInsights('possibly_superseded')).toHaveLength(0);
    expect(app.services.actions.list('proposed').filter((x) => x.actionType === 'supersede_decision')).toHaveLength(1);
  });

  it('a contradiction detected later replaces the „möglicherweise überholt“ hint of the pair', async () => {
    app.llm.down = true;
    const a = await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    const b = await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    await app.services.consistency.run({ trigger: 'test' });
    const superseded = openInsights('possibly_superseded')[0]!;
    expect(superseded).toBeDefined();

    await app.ok('decisions:update', { id: a.id, patch: { decisionText: 'Wir führen prod-plat weiter.' } });
    await app.ok('decisions:update', { id: b.id, patch: { decisionText: 'Wir machen mit prod-plat vorerst nicht weiter.' } });
    await app.services.consistency.run({ trigger: 'test' });

    expect(openInsights('contradiction')).toHaveLength(1);
    expect(openInsights('possibly_superseded')).toHaveLength(0);
    expect(actionStatus(superseded.recommendedActionId!)).toBe('withdrawn');
    expect(app.services.actions.list('proposed').filter((x) => x.actionType === 'supersede_decision')).toHaveLength(1);
  });

  it('supersede() is idempotent: a second replace changes and records nothing', async () => {
    app.llm.down = true;
    const a = await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    const b = await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    app.services.decisions.supersede({ oldId: a.id, newId: b.id, confirmed: true });
    const audits = () => app.services.audit.list({ limit: 100 }).filter((e) => e.action === 'decision.supersede').length;
    const before = audits();

    const again = app.services.decisions.supersede({ oldId: a.id, newId: b.id, confirmed: true });

    expect(again.old.status).toBe('superseded');
    expect(again.new.supersedesDecisionId).toBe(a.id);
    expect(audits()).toBe(before);
  });

  it("the archive check respects the LLM's veto (and does not ask again on every run)", async () => {
    app.llm.on('ContradictionProposal', () => ({ isContradiction: false, confidence: 0.9, description: 'Präzisierung, kein Widerspruch.' }));
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    expect(await app.ok('contradictions:list', {})).toHaveLength(0);

    await app.services.consistency.run({ trigger: 'test' });
    const asked = app.llm.calls.filter((c) => c.schema === 'ContradictionProposal').length;
    await app.services.consistency.run({ trigger: 'test' });

    expect(await app.ok('contradictions:list', {})).toHaveLength(0);
    expect(openInsights('contradiction')).toHaveLength(0);
    expect(app.llm.calls.filter((c) => c.schema === 'ContradictionProposal').length).toBe(asked);
  });

  it('if one of the decisions is revoked otherwise, the check closes the contradiction along with the proposal', async () => {
    app.llm.down = true;
    const a = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const ins = contradictionInsight()!;

    app.services.decisions.revoke(a.id, { confirmed: true });
    await app.services.consistency.run({ trigger: 'test' });

    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('resolved');
    expect(contradictionInsight()).toBeUndefined();
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
  });
});

describe('Accepting again is possible after a failure', () => {
  it('if the action fails once, the hint stays open and the second attempt executes it', async () => {
    app.llm.down = true;
    const a = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const ins = openInsights('contradiction')[0]!;
    // only the first attempt fails; afterwards the real implementation runs again
    vi.spyOn(app.services.decisions, 'supersede').mockImplementationOnce(() => {
      throw new Error('Datenbank gesperrt');
    });

    const failed = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });
    expect(failed.ok).toBe(false);
    expect(app.services.insights.get(ins.id).status).toBe('open');
    expect(actionStatus(ins.recommendedActionId!)).toBe('failed');

    const accepted = await app.ok('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });

    expect(accepted.status).toBe('accepted');
    expect(accepted.recommendedActionId).not.toBe(ins.recommendedActionId);
    expect(actionStatus(accepted.recommendedActionId!)).toBe('executed');
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('superseded');
  });
});

describe('Outdated proposals are re-checked before execution', () => {
  it('if the user has since put the document elsewhere, the older insight does not move it back', async () => {
    const { odd } = await scattered();
    await app.services.consistency.run({ trigger: 'test' });
    const ins = openInsights('scattered_documents')[0]!;

    await relocate(odd, 'work/hr/bildungsurlaub'); // e.g. moved via chat in the meantime
    const res = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toContain('nicht mehr aktuell');
    expect(folderOf(odd)).toBe('work/hr/bildungsurlaub');
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
    expect(openInsights('scattered_documents')).toHaveLength(0);

    // the next check evaluates the current state afresh
    await app.services.consistency.run({ trigger: 'test' });
    const fresh = openInsights('scattered_documents')[0]!;
    expect(app.services.actions.get(fresh.recommendedActionId!).status).toBe('proposed');
  });

  it('a relocation proposal in the chat withdraws open proposals from other sources for the same documents', async () => {
    await scattered();
    await app.services.consistency.run({ trigger: 'test' });
    const ins = openInsights('scattered_documents')[0]!;
    app.llm.on('ChatIntent', () => ({ intent: 'archive_reorganize', confidence: 0.9, rationale: 'test', topic: TOPIC, path: 'work/hr/bildungsurlaub' }));

    const r = await app.ok('chat:send', { text: `leg alle ${TOPIC} nach work/hr/bildungsurlaub` });

    expect(r.assistantMessage.actions).toHaveLength(1);
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
    expect(openInsights('scattered_documents')).toHaveLength(0);
    expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents')).toHaveLength(1);
  });

  it('if the older decision has since been revoked, it is no longer replaced', async () => {
    app.llm.down = true;
    const a = await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    await app.services.consistency.run({ trigger: 'test' });
    const ins = openInsights('possibly_superseded')[0]!;

    app.services.decisions.revoke(a.id, { confirmed: true });
    const res = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });

    expect(res.ok).toBe(false);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('revoked');
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
  });

  it('an action that was already decided cannot be withdrawn', async () => {
    const { odd } = await scattered();
    await app.services.consistency.run({ trigger: 'test' });
    const actionId = openInsights('scattered_documents')[0]!.recommendedActionId!;
    await app.services.actions.resolve(actionId, { decision: 'approve', confirmed: true });

    expect(app.services.actions.withdraw(actionId, 'egal')).toBe(false);
    expect(actionStatus(actionId)).toBe('executed');
    expect(folderOf(odd)).toBe('private/bildungsurlaub/2026');
  });
});
