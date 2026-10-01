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

describe('Archivprüfung: zurückgezogene Hinweise ziehen ihre Aktion mit zurück', () => {
  it('entfällt die Ursache, verschwindet der Hinweis und seine Aktion wird „withdrawn“ (nicht „proposed“)', async () => {
    const { odd } = await scattered();
    await app.services.consistency.run('test');
    const [insight] = openInsights('scattered_documents');
    const actionId = insight!.recommendedActionId!;
    expect(actionStatus(actionId)).toBe('proposed');

    await relocate(odd, 'private/bildungsurlaub/2026'); // the user tidied up by other means
    await app.services.consistency.run('test');

    expect(openInsights('scattered_documents')).toHaveLength(0);
    expect(actionStatus(actionId)).toBe('withdrawn');
    expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents')).toHaveLength(0);
  });

  it('ändert sich die Verteilung, ersetzt der Hinweis seinen Vorschlag statt einen zweiten anzulegen', async () => {
    await scattered();
    await app.services.consistency.run('test');
    const first = openInsights('scattered_documents')[0]!;

    const extra = await archived('Ticket', 'work/tickets');
    await app.services.consistency.run('test');

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

describe('Stabile Schlüssel: ein Lauf schließt Hinweise, deren Ursache nicht mehr besteht', () => {
  it('fehlende Archivdatei: Hinweis verschwindet, sobald die Datei wieder da ist', async () => {
    const id = await archived('Vertrag', 'work/vertraege');
    const abs = path.join(archiveRoot(), row(id).archiveRelPath!);
    const backup = fs.readFileSync(abs);
    fs.unlinkSync(abs);
    await app.services.consistency.run('test');
    await app.services.consistency.run('test');
    expect(openInsights('misplaced_file').filter((i) => i.title.includes('fehlt'))).toHaveLength(1);

    fs.writeFileSync(abs, backup);
    await app.services.consistency.run('test');

    expect(openInsights('misplaced_file')).toHaveLength(0);
  });

  it('unvollständige Entscheidung: ein Hinweis je Entscheidung, auch wenn sich die fehlenden Felder ändern; vollständig → geschlossen', async () => {
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
    await app.services.consistency.run('test');
    expect(openInsights('incomplete_decision')).toHaveLength(1);

    await app.ok('decisions:update', { id: d.id, patch: { participants: ['Anna'] } });
    await app.services.consistency.run('test');
    const still = openInsights('incomplete_decision');
    expect(still).toHaveLength(1);
    expect(still[0]!.explanation).not.toContain('Beteiligte');

    await app.ok('decisions:update', { id: d.id, patch: { participants: ['Anna'], decidedAt: '2026-03-01' } });
    await app.services.consistency.run('test');
    expect(openInsights('incomplete_decision')).toHaveLength(0);
    expect((await app.ok('notifications:list', {})).filter((n) => n.type === 'incomplete_decision')).toHaveLength(0);
  });

  it('Dokumente ohne Thema: ein einziger Hinweis, der mitwächst, statt eines neuen je Änderung', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run('test');
    await archived('Zweite lose Notiz', 'work/notizen', null);
    await app.services.consistency.run('test');

    const orphan = openInsights('orphan_document');
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.sourceIds).toHaveLength(2);
  });

  it('überfällige Punkte: die Benachrichtigung schließt sich, wenn der Punkt erledigt ist', async () => {
    const item = await app.ok('openItems:create', {
      title: 'Steuerbescheid prüfen',
      dueAt: '2020-01-01',
      priority: 'normal',
      sourceIds: [],
      confidence: 0.9,
    } as never);
    await app.services.consistency.run('test');
    expect((await app.ok('notifications:list', {})).some((n) => n.type === 'open_item_overdue')).toBe(true);

    await app.ok('openItems:close', { id: item.id, status: 'resolved', confirmed: true });
    await app.services.consistency.run('test');

    expect((await app.ok('notifications:list', {})).some((n) => n.type === 'open_item_overdue')).toBe(false);
  });
});

describe('Annehmen ohne Aktion verbirgt ein Problem nicht für immer', () => {
  it('kehrt die Ursache zurück, nachdem sie behoben war, wird sie erneut gemeldet', async () => {
    const id = await archived('Vertrag', 'work/vertraege');
    const abs = path.join(archiveRoot(), row(id).archiveRelPath!);
    const backup = fs.readFileSync(abs);
    fs.unlinkSync(abs);
    await app.services.consistency.run('test');
    const missing = openInsights('misplaced_file')[0]!;
    await app.ok('insights:respond', { response: 'accept', id: missing.id, confirmed: true, strongConfirmed: false });
    await app.services.consistency.run('test');
    expect(openInsights('misplaced_file'), 'eben bestätigt: nicht sofort erneut').toHaveLength(0);

    fs.writeFileSync(abs, backup);
    await app.services.consistency.run('test');
    fs.unlinkSync(abs);
    await app.services.consistency.run('test');

    expect(openInsights('misplaced_file')).toHaveLength(1);
  });

  it('kommen neue betroffene Objekte hinzu, öffnet sich der bestätigte Hinweis wieder', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run('test');
    await app.ok('insights:respond', { response: 'accept', id: openInsights('orphan_document')[0]!.id, confirmed: true, strongConfirmed: false });

    await archived('Zweite lose Notiz', 'work/notizen', null);
    await app.services.consistency.run('test');

    expect(openInsights('orphan_document')).toHaveLength(1);
  });

  it('besteht die Ursache Tage nach dem Bestätigen noch, wird der Hinweis wieder geöffnet', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run('test');
    const ins = openInsights('orphan_document')[0]!;
    await app.ok('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });
    await app.services.consistency.run('test');
    expect(openInsights('orphan_document')).toHaveLength(0);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    try {
      await app.services.consistency.run('test');
    } finally {
      vi.useRealTimers();
    }

    expect(openInsights('orphan_document').map((i) => i.id)).toEqual([ins.id]);
  });

  it('abgelehnte Hinweise bleiben abgelehnt, solange die Ursache besteht', async () => {
    await archived('Lose Notiz', 'work/notizen', null);
    await app.services.consistency.run('test');
    await app.ok('insights:respond', { response: 'reject', id: openInsights('orphan_document')[0]!.id });
    await app.services.consistency.run('test');
    expect(openInsights('orphan_document')).toHaveLength(0);
  });
});

describe('Widerspruch, Insight und Aktion: ein gemeinsamer Lebenszyklus', () => {
  const contradictionInsight = () => openInsights('contradiction')[0];
  const contradictionNotes = async () => (await app.ok('notifications:list', {})).filter((n) => n.type === 'contradiction');

  it('„Auflösen“ am Widerspruch schließt auch Insight, Ersetzen-Aktion und Benachrichtigung', async () => {
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

  it('Ersetzen über das Insight löst den Widerspruch auf', async () => {
    app.llm.down = true;
    const a = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    await app.ok('insights:respond', { response: 'accept', id: contradictionInsight()!.id, confirmed: true, strongConfirmed: false });

    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('superseded');
    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('resolved');
    expect(await contradictionNotes()).toHaveLength(0);
  });

  it('Ablehnen des Insights nimmt den Widerspruch zur Kenntnis und schließt die Benachrichtigung', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    await app.ok('insights:respond', { response: 'reject', id: contradictionInsight()!.id });

    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('acknowledged');
    expect(await contradictionNotes()).toHaveLength(0);
  });

  it('kein zusätzlicher „möglicherweise überholt“-Vorschlag für ein Paar mit Widerspruch', async () => {
    app.llm.down = true;
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');

    await app.services.consistency.run('test');

    expect(openInsights('contradiction')).toHaveLength(1);
    expect(openInsights('possibly_superseded')).toHaveLength(0);
    expect(app.services.actions.list('proposed').filter((x) => x.actionType === 'supersede_decision')).toHaveLength(1);
  });

  it('ein später erkannter Widerspruch ersetzt den „möglicherweise überholt“-Hinweis des Paares', async () => {
    app.llm.down = true;
    const a = await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    const b = await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    await app.services.consistency.run('test');
    const superseded = openInsights('possibly_superseded')[0]!;
    expect(superseded).toBeDefined();

    await app.ok('decisions:update', { id: a.id, patch: { decisionText: 'Wir führen prod-plat weiter.' } });
    await app.ok('decisions:update', { id: b.id, patch: { decisionText: 'Wir machen mit prod-plat vorerst nicht weiter.' } });
    await app.services.consistency.run('test');

    expect(openInsights('contradiction')).toHaveLength(1);
    expect(openInsights('possibly_superseded')).toHaveLength(0);
    expect(actionStatus(superseded.recommendedActionId!)).toBe('withdrawn');
    expect(app.services.actions.list('proposed').filter((x) => x.actionType === 'supersede_decision')).toHaveLength(1);
  });

  it('supersede() ist idempotent: ein zweites Ersetzen ändert und protokolliert nichts', async () => {
    app.llm.down = true;
    const a = await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    const b = await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    app.services.decisions.supersede(a.id, b.id, { confirmed: true });
    const audits = () => app.services.audit.list(100).filter((e) => e.action === 'decision.supersede').length;
    const before = audits();

    const again = app.services.decisions.supersede(a.id, b.id, { confirmed: true });

    expect(again.old.status).toBe('superseded');
    expect(again.new.supersedesDecisionId).toBe(a.id);
    expect(audits()).toBe(before);
  });

  it('die Archivprüfung respektiert das Veto des LLM (und fragt nicht bei jedem Lauf erneut)', async () => {
    app.llm.on('ContradictionProposal', () => ({ isContradiction: false, confidence: 0.9, description: 'Präzisierung, kein Widerspruch.' }));
    await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    expect(await app.ok('contradictions:list', {})).toHaveLength(0);

    await app.services.consistency.run('test');
    const asked = app.llm.calls.filter((c) => c.schema === 'ContradictionProposal').length;
    await app.services.consistency.run('test');

    expect(await app.ok('contradictions:list', {})).toHaveLength(0);
    expect(openInsights('contradiction')).toHaveLength(0);
    expect(app.llm.calls.filter((c) => c.schema === 'ContradictionProposal').length).toBe(asked);
  });

  it('wird eine der Entscheidungen anderweitig widerrufen, schließt die Prüfung den Widerspruch samt Vorschlag', async () => {
    app.llm.down = true;
    const a = await decision('Wir führen prod-plat weiter.', '2026-01-10');
    await decision('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01');
    const ins = contradictionInsight()!;

    app.services.decisions.revoke(a.id, { confirmed: true });
    await app.services.consistency.run('test');

    expect((await app.ok('contradictions:list', {}))[0]!.status).toBe('resolved');
    expect(contradictionInsight()).toBeUndefined();
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
  });
});

describe('Nach einem Fehlschlag ist erneutes Annehmen möglich', () => {
  it('schlägt die Aktion einmal fehl, bleibt der Hinweis offen und der zweite Versuch führt sie aus', async () => {
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

describe('Veraltete Vorschläge werden vor dem Ausführen erneut geprüft', () => {
  it('hat der Benutzer das Dokument inzwischen woanders hingelegt, schiebt das ältere Insight es nicht zurück', async () => {
    const { odd } = await scattered();
    await app.services.consistency.run('test');
    const ins = openInsights('scattered_documents')[0]!;

    await relocate(odd, 'work/hr/bildungsurlaub'); // e.g. moved via chat in the meantime
    const res = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toContain('nicht mehr aktuell');
    expect(folderOf(odd)).toBe('work/hr/bildungsurlaub');
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
    expect(openInsights('scattered_documents')).toHaveLength(0);

    // the next check evaluates the current state afresh
    await app.services.consistency.run('test');
    const fresh = openInsights('scattered_documents')[0]!;
    expect(app.services.actions.get(fresh.recommendedActionId!).status).toBe('proposed');
  });

  it('ein Umlager-Vorschlag im Chat zieht offene Vorschläge anderer Quellen für dieselben Dokumente zurück', async () => {
    await scattered();
    await app.services.consistency.run('test');
    const ins = openInsights('scattered_documents')[0]!;
    app.llm.on('ChatIntent', () => ({ intent: 'archive_reorganize', confidence: 0.9, rationale: 'test', topic: TOPIC, path: 'work/hr/bildungsurlaub' }));

    const r = await app.ok('chat:send', { text: `leg alle ${TOPIC} nach work/hr/bildungsurlaub` });

    expect(r.assistantMessage.actions).toHaveLength(1);
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
    expect(openInsights('scattered_documents')).toHaveLength(0);
    expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents')).toHaveLength(1);
  });

  it('ist die ältere Entscheidung inzwischen widerrufen, wird nicht mehr ersetzt', async () => {
    app.llm.down = true;
    const a = await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    await app.services.consistency.run('test');
    const ins = openInsights('possibly_superseded')[0]!;

    app.services.decisions.revoke(a.id, { confirmed: true });
    const res = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });

    expect(res.ok).toBe(false);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('revoked');
    expect(actionStatus(ins.recommendedActionId!)).toBe('withdrawn');
  });

  it('eine bereits entschiedene Aktion lässt sich nicht zurückziehen', async () => {
    const { odd } = await scattered();
    await app.services.consistency.run('test');
    const actionId = openInsights('scattered_documents')[0]!.recommendedActionId!;
    await app.services.actions.resolve(actionId, 'approve', { confirmed: true });

    expect(app.services.actions.withdraw(actionId, 'egal')).toBe(false);
    expect(actionStatus(actionId)).toBe('executed');
    expect(folderOf(odd)).toBe('private/bildungsurlaub/2026');
  });
});
