import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const decisionEx = (over: Record<string, unknown> = {}) => ({ participants: [], alternatives: [], unknownFields: [], confidence: 0.85, ...over });

describe('Decision-Workflow mit Rückfragen (LLM)', () => {
  it('stellt gezielte Rückfragen, speichert erst vollständig und findet die Entscheidung wieder', async () => {
    let step = 0;
    app.llm.on('ChatIntent', (_s, input) => {
      step += 1;
      if (/prod-plat erstmal nicht weitermachen/.test(input) && step === 1) {
        return intent({
          intent: 'decision_new',
          decision: decisionEx({
            decisionText: 'Wir machen mit prod-plat erstmal nicht weiter.',
            title: 'prod-plat pausiert',
            topic: 'prod-plat',
            topicIsProject: null,
          }),
        });
      }
      if (/Am 3\. März/.test(input)) {
        return intent({ intent: 'decision_amend', decision: decisionEx({ decidedAt: '2026-03-03', participants: ['Anna', 'Ben'], topicIsProject: true }) });
      }
      if (/Wann haben wir/.test(input)) return intent({ intent: 'knowledge_question', query: 'prod-plat pausiert Entscheidung' });
      return intent({ intent: 'unknown' });
    });
    app.llm.on('KnowledgeAnswer', (_s, input) => {
      expect(input).toContain('[S1]');
      return {
        answer: 'prod-plat wurde am 3. März 2026 pausiert.',
        facts: [
          { statement: 'Die Entscheidung zur Pause fiel am 2026-03-03.', sourceIds: ['S1'] },
          { statement: 'Erfundene Aussage ohne Beleg.', sourceIds: ['S99'] },
        ],
        interpretation: 'Die Pause könnte mit dem Budget zusammenhängen.',
        uncertainties: [],
        contradictions: [],
        missingInformation: ['Begründung der Pause'],
        usedSourceIds: ['S1', 'S42'],
        confidence: 0.8,
      };
    });

    const r1 = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.' });
    const m1 = r1.assistantMessage;
    expect(m1.content).toContain('Wann wurde das entschieden?');
    expect(m1.content).toContain('Wer war an der Entscheidung beteiligt?');
    expect(m1.content).toMatch(/„prod-plat“ das Thema oder der Name des Projekts/);
    const draft = (await app.ok('decisions:list', {}))[0]!;
    expect(draft.status).toBe('draft');
    expect(draft.missingFields.sort()).toEqual(['decidedAt', 'participants']);

    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Am 3. März 2026 mit Anna und Ben, prod-plat ist ein Projekt.' });
    expect(r2.assistantMessage.content).toContain('Die Entscheidung ist gespeichert');
    const saved = await app.ok('decisions:get', { id: draft.id });
    expect(saved.status).toBe('active');
    expect(saved.decidedAt?.slice(0, 10)).toBe('2026-03-03');
    expect(saved.participants).toEqual(['Anna', 'Ben']);
    expect(saved.projectName).toBe('prod-plat');
    expect(saved.missingFields).toEqual([]);

    const r3 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Wann haben wir prod-plat pausiert?' });
    const a = r3.assistantMessage;
    expect(a.sources.length).toBeGreaterThan(0);
    expect(a.sources[0]!.type).toBe('decision');
    expect(a.content).toContain('3. März 2026');
    expect(a.content).not.toContain('Erfundene Aussage');
    expect(a.content).toContain('Einschätzung');
    expect(a.uncertainties.join(' ')).toMatch(/Begründung der Pause/);
    expect(a.uncertainties.join(' ')).toMatch(/ohne gültigen Quellenbeleg/);
    expect(a.context?.decisions?.length).toBeGreaterThan(0);
  });

  it('speichert Felder, die ausdrücklich als unbekannt bestätigt wurden', async () => {
    let n = 0;
    app.llm.on('ChatIntent', () => {
      n += 1;
      return n === 1
        ? intent({
            intent: 'decision_new',
            decision: decisionEx({ decisionText: 'Wir wechseln den Stromanbieter.', topic: 'Strom', topicIsProject: false, decidedAt: '2026-02-01' }),
          })
        : intent({ intent: 'decision_amend', decision: decisionEx({ unknownFields: ['participants'] }) });
    });
    const r1 = await app.ok('chat:send', { text: 'Wir wechseln den Stromanbieter, seit 1.2.2026.' });
    expect(r1.assistantMessage.content).toContain('Wer war an der Entscheidung beteiligt?');
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Weiß ich nicht.' });
    expect(r2.assistantMessage.content).toContain('gespeichert');
    expect(r2.assistantMessage.uncertainties.join(' ')).toMatch(/Beteiligte.*unbekannt/);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.status).toBe('active');
    expect(d.unknownFields).toContain('participants');
  });
});

describe('Decision-Workflow ohne LLM (regelbasierter Fallback)', () => {
  it('fragt schrittweise nach und weist auf den fehlenden LLM hin', async () => {
    app.llm.down = true;
    const r1 = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.' });
    expect(r1.assistantMessage.content).toContain('Wann wurde das entschieden?');
    expect(r1.assistantMessage.content).not.toContain('Wer war an der Entscheidung');
    expect(r1.assistantMessage.errorMessage).toMatch(/nicht erreichbar/);
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '12.03.2026' });
    expect(r2.assistantMessage.content).toContain('Wer war an der Entscheidung beteiligt?');
    const r3 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Anna und Ben' });
    expect(r3.assistantMessage.content).toContain('gespeichert');
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.decidedAt?.slice(0, 10)).toBe('2026-03-12');
    expect(d.participants).toEqual(['Anna', 'Ben']);
    expect(d.topicName).toBe('prod-plat');
  });

  it('liefert bei Wissensfragen ohne LLM eine lokale Trefferliste mit Quellen', async () => {
    await app.ok('decisions:create', {
      decisionText: 'Wir pausieren prod-plat.',
      title: 'prod-plat pausiert',
      topic: 'prod-plat',
      decidedAt: '2026-03-03',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    await app.services.search.index({ type: 'note', id: 'x', title: 'x', content: 'x' }).catch(() => undefined);
    app.llm.down = true;
    const r = await app.ok('chat:send', { text: 'Wann haben wir prod-plat pausiert?' });
    expect(r.assistantMessage.sources[0]?.type).toBe('decision');
    expect(r.assistantMessage.content).toMatch(/lokale Trefferliste/);
    expect(r.assistantMessage.confidence).toBeLessThan(0.6);
  });

  it('gibt offen zu, wenn nichts gefunden wurde', async () => {
    const r = await app.ok('chat:send', { text: 'Haben wir jemals über Vault gesprochen?' });
    expect(r.assistantMessage.content).toMatch(/nichts/);
    expect(r.assistantMessage.sources).toHaveLength(0);
  });
});

describe('Widersprüche und Ersetzen nur nach Bestätigung', () => {
  const mk = (text: string, date: string) => ({
    decisionText: text,
    title: text.slice(0, 40),
    topic: 'prod-plat',
    decidedAt: date,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

  it('erkennt zwei widersprüchliche Entscheidungen, zeigt Insight + Hinweis und ersetzt erst nach Bestätigung', async () => {
    app.llm.down = true; // rein lexikalische Prüfung mit kontrollierten Beispieldaten
    const a = await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const b = await app.ok('decisions:create', mk('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01'));
    const list = await app.ok('contradictions:list', {});
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('detected');
    expect(list[0]!.affectedEntityIds.sort()).toEqual([a.id, b.id].sort());
    expect(list[0]!.confidence).toBeGreaterThan(0.5);

    const insights = await app.ok('insights:list', { status: 'open' });
    const ins = insights.find((i) => i.kind === 'contradiction')!;
    expect(ins.recommendedActionLabel).toMatch(/ersetzt/);
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((n) => n.type === 'contradiction')).toBe(true);

    // keine autonome Änderung
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');

    // ohne Bestätigung abgelehnt
    const denied = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: false as unknown as true, strongConfirmed: false });
    expect(denied.ok).toBe(false);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');

    await app.ok('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });
    const old = await app.ok('decisions:get', { id: a.id });
    expect(old.status).toBe('superseded');
    expect((await app.ok('decisions:get', { id: b.id })).supersedesDecisionId).toBe(a.id);

    // Undo prüft vorher auf neuere Änderungen
    const audit = await app.ok('audit:list', { limit: 50, onlyUndoable: true });
    const entry = audit.find((e) => e.action === 'decision.supersede')!;
    await app.ok('decisions:update', { id: a.id, patch: { rationale: 'nachträglich ergänzt' } });
    const blocked = await app.ok('audit:undo', { auditId: entry.id });
    expect(blocked.undone).toBe(false);
    expect(blocked.conflicts.join(' ')).toMatch(/verändert/);
  });

  it('Undo stellt den Status wieder her, wenn nichts geändert wurde', async () => {
    app.llm.down = true;
    const a = await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const b = await app.ok('decisions:create', mk('prod-plat wird eingestellt.', '2026-03-01'));
    const act = await app.services.actions.resolve((await app.ok('actions:list', { status: 'proposed' }))[0]!.id, 'approve', { confirmed: true });
    expect(act.status).toBe('executed');
    const entry = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((e) => e.action === 'decision.supersede')!;
    const res = await app.ok('audit:undo', { auditId: entry.id });
    expect(res.undone).toBe(true);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');
    expect((await app.ok('decisions:get', { id: b.id })).supersedesDecisionId).toBeNull();
  });

  it('zeigt im Chat den Ersetzen-Vorschlag, wenn eine neue Entscheidung im Widerspruch steht', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir prod-plat pausieren. Datum 01.03.2026.' });
    // regelbasiert: Datum erkannt, Thema prod-plat erkannt, Beteiligte fehlen → Rückfrage
    expect(r.assistantMessage.content).toContain('Wer war an der Entscheidung beteiligt?');
    const r2 = await app.ok('chat:send', { conversationId: r.conversationId, text: 'Anna' });
    expect(r2.assistantMessage.content).toMatch(/Widerspruch|widersprüchlich/);
    expect(r2.assistantMessage.actions.some((x) => x.actionType === 'supersede_decision' && x.status === 'proposed')).toBe(true);
  });
});

describe('Offene Punkte, Erinnerungen und Notification Bell', () => {
  it('legt einen offenen Punkt an, fragt nach Fehlendem, erinnert und schließt nur nach Bestätigung', async () => {
    let n = 0;
    app.llm.on('ChatIntent', () => {
      n += 1;
      if (n === 1) return intent({ intent: 'open_item_new', topic: 'Hauskauf', openItem: { title: 'Finanzierungszusage einholen', dueAt: null } });
      if (n === 2) return intent({ intent: 'open_item_update', openItem: { responsible: 'Anna', dueAt: '2026-10-20' } });
      if (n === 3) return intent({ intent: 'reminder_create', reminder: { remindAt: '2026-10-08', relativeText: 'in sieben Tagen' } });
      return intent({ intent: 'open_item_close', openItem: { targetHint: 'Finanzierungszusage' } });
    });
    const r1 = await app.ok('chat:send', { text: 'Offener Punkt: Finanzierungszusage einholen (Hauskauf)' });
    expect(r1.assistantMessage.content).toMatch(/Wer ist verantwortlich/);
    expect(r1.assistantMessage.uncertainties.length).toBe(2);

    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Anna, bis 20.10.' });
    expect(r2.assistantMessage.content).toContain('Anna');
    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.responsibleName).toBe('Anna');
    expect(item.dueAt?.slice(0, 10)).toBe('2026-10-20');
    expect(item.topicName).toBe('Hauskauf');

    const r3 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Erinnere mich in sieben Tagen wieder daran' });
    expect(r3.assistantMessage.content).toContain('2026-10-08');
    const reminders = await app.ok('reminders:list', {});
    expect(reminders[0]!.targetId).toBe(item.id);

    // Erinnerung wird fällig → Notification Bell
    app.services.ctx.database.sqlite.prepare('UPDATE reminders SET remind_at = ?').run('2020-01-01');
    expect(app.services.reminders.checkDue()).toBe(1);
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((x) => x.type === 'reminder' && x.title.includes('Finanzierungszusage'))).toBe(true);
    expect((await app.ok('app:getStatus', {})).unreadNotifications).toBeGreaterThan(0);

    // Schließen: nur Vorschlag, bis bestätigt
    const r4 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Schließe den Punkt Finanzierungszusage' });
    expect(r4.assistantMessage.actions).toHaveLength(1);
    expect((await app.ok('openItems:list', {}))[0]!.status).toBe('open');
    const noConfirm = await app.call('openItems:close', { id: item.id, status: 'resolved', confirmed: false as unknown as true });
    expect(noConfirm.ok).toBe(false);
    await app.ok('actions:resolve', { decision: 'approve', actionId: r4.assistantMessage.actions[0]!.id, confirmed: true, strongConfirmed: false });
    expect((await app.ok('openItems:list', {}))[0]!.status).toBe('resolved');
    const undoable = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((e) => e.action === 'open_item.close')!;
    expect((await app.ok('audit:undo', { auditId: undoable.id })).undone).toBe(true);
    expect((await app.ok('openItems:list', {}))[0]!.status).toBe('open');
  });

  it('meldet überfällige offene Punkte bei der Archivprüfung', async () => {
    app.llm.down = true;
    await app.ok('openItems:create', { title: 'Steuerbescheid prüfen', dueAt: '2020-01-01', priority: 'normal', sourceIds: [], confidence: 0.9 });
    await app.services.consistency.run('test');
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((n) => n.type === 'open_item_overdue')).toBe(true);
    expect(notes.some((n) => n.type === 'open_item_no_owner')).toBe(true);
  });
});

describe('Ungültige LLM-Ausgaben lösen nichts aus', () => {
  it('verwirft Antworten, die nicht dem Schema entsprechen, und verändert nichts', async () => {
    app.llm.on('ChatIntent', () => ({ intent: 'decision_new', confidence: 7, decision: { participants: 'Anna' } }));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, X zu tun.' });
    // fällt auf regelbasierte Auswertung zurück und kennzeichnet den technischen Fehler sichtbar
    expect(r.assistantMessage.errorMessage).toMatch(/Format/);
    const calls = app.llm.calls.filter((c) => c.schema === 'ChatIntent');
    expect(calls.length).toBe(2); // eine Korrekturanfrage
    expect(calls[1]!.input).toContain('ungültig');
  });

  it('akzeptiert eine korrigierte Antwort im zweiten Versuch', async () => {
    let k = 0;
    app.llm.on('ChatIntent', () => (++k === 1 ? 'das ist kein json' : intent({ intent: 'smalltalk' })));
    const r = await app.ok('chat:send', { text: 'Hallo' });
    expect(r.assistantMessage.errorMessage).toBeNull();
    expect(k).toBe(2);
  });

  it('lehnt Aktionen mit ungültigen Parametern ab', () => {
    expect(() =>
      app.services.actions.propose({
        actionType: 'supersede_decision',
        rationale: 'x',
        confidence: 0.5,
        affectedEntities: [],
        requiredConfirmation: 'confirm',
        proposedParameters: { oldDecisionId: 5 },
        label: 'x',
      }),
    ).toThrow(/ungültige Parameter/);
  });
});

describe('Rückfrage nach dem Erinnerungsdatum behält den Kontext', () => {
  const note = 'Bezüglich AI und Stackit hatten wir ein Mini-Projekt. Es wurde noch nicht im ACT-Team vorgestellt. Dafür bräuchte ich eine Erinnerung.';

  it('versteht „31.10.“ als Antwort auf „Wann soll ich dich erinnern?“ (mit LLM)', async () => {
    let n = 0;
    app.llm.on('ChatIntent', (_s, input) => {
      n += 1;
      // der LLM bekommt die offene Rückfrage mitgeteilt
      if (n === 2) expect(input).toMatch(/WANN er an .* erinnern soll/);
      return n === 1
        ? intent({ intent: 'reminder_create', reminder: { title: 'Mini-PoC im ACT-Team vorstellen' } })
        : intent({ intent: 'reminder_create', reminder: { remindAt: '2026-10-31' } });
    });
    const r1 = await app.ok('chat:send', { text: note });
    expect(r1.assistantMessage.content).toContain('Wann soll ich dich erinnern?');
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '31.10.' });
    expect(r2.assistantMessage.content).toContain('2026-10-31');
    const rem = (await app.ok('reminders:list', {}))[0]!;
    expect(rem.remindAt).toBe('2026-10-31');
    expect(rem.title).toBe('Mini-PoC im ACT-Team vorstellen');
    // Aus der Erinnerung entsteht ein offener Punkt (mit Fälligkeit) und eine Notiz – beides erscheint in Timeline und Suche
    const items = await app.ok('openItems:list', {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Mini-PoC im ACT-Team vorstellen', status: 'open' });
    expect(items[0]!.dueAt?.slice(0, 10)).toBe('2026-10-31');
    expect(rem.targetId).toBe(items[0]!.id);
    expect(r2.assistantMessage.content).toMatch(/offenen Punkt .*angelegt/);
    expect(r2.assistantMessage.content).toMatch(/Notiz gespeichert/);
    expect(r2.assistantMessage.content).toMatch(/keine Entscheidung|keine erfasst/);
    expect((await app.ok('decisions:list', {})).length).toBe(0);
    expect((await app.ok('timeline:get', {})).some((e) => e.kind === 'open_item' && e.date === '2026-10-31')).toBe(true);
    expect((await app.ok('search:global', { query: 'Stackit Mini-Projekt', limit: 5 })).some((h) => h.type === 'note')).toBe(true);
  });

  it('funktioniert auch ohne LLM und verfällt nach einer fremden Nachricht', async () => {
    app.llm.down = true;
    const r1 = await app.ok('chat:send', { text: 'Erinnere mich bitte an das Treffen mit dem Team.' });
    expect(r1.assistantMessage.content).toContain('Wann soll ich dich erinnern?');
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '31.10.' });
    expect(r2.assistantMessage.content).toContain('angelegt');
    expect((await app.ok('reminders:list', {}))[0]!.title).toMatch(/Treffen mit dem Team/);

    const r3 = await app.ok('chat:send', { text: 'Erinnere mich an die Steuererklärung.' });
    await app.ok('chat:send', { conversationId: r3.conversationId, text: 'Wie viele Dokumente gibt es?' });
    const r5 = await app.ok('chat:send', { conversationId: r3.conversationId, text: '15.11.' });
    expect(r5.assistantMessage.content).not.toContain('angelegt'); // Rückfrage ist nicht mehr offen
    expect(await app.ok('reminders:list', {})).toHaveLength(1);
  });
});

describe('Unterhaltungen umbenennen', () => {
  it('ändert nur den Titel, bereinigt Eingaben und lehnt Leeres ab', async () => {
    app.llm.down = true;
    const r = await app.ok('chat:send', { text: 'Hallo Archivist' });
    const renamed = await app.ok('chat:renameConversation', { id: r.conversationId, title: '  Konferenz   Beitrag  ' });
    expect(renamed.title).toBe('Konferenz Beitrag');
    expect((await app.ok('chat:conversations', {}))[0]!.title).toBe('Konferenz Beitrag');
    expect((await app.ok('chat:history', { conversationId: r.conversationId })).length).toBe(2);
    // der neue Titel wird von späteren Nachrichten nicht überschrieben
    await app.ok('chat:send', { conversationId: r.conversationId, text: 'Noch eine Nachricht' });
    expect((await app.ok('chat:conversations', {}))[0]!.title).toBe('Konferenz Beitrag');
    expect((await app.call('chat:renameConversation', { id: r.conversationId, title: '   ' })).ok).toBe(false);
    expect((await app.call('chat:renameConversation', { id: 'gibt-es-nicht', title: 'x' })).ok).toBe(false);
  });
});

describe('Mehrere Absichten und Rückfragen bei Unsicherheit', () => {
  const msg =
    'Für den Konferenzbeitrag habe ich es leicht abgewandelt und am 01.10.2026 beim German Testing Day eingereicht. Erinnere mich am 15.11.2026 an das Feedback.';
  const decisionUnsure = () =>
    intent({
      intent: 'decision_new',
      segment: 'am 01.10.2026 eingereicht',
      decisionCertainty: 'unsure',
      decision: decisionEx({
        decisionText: 'Beitrag beim German Testing Day eingereicht.',
        title: 'Beitrag eingereicht',
        topic: 'Konferenz',
        decidedAt: '2026-10-01',
      }),
    });
  const reminder = () =>
    intent({ intent: 'reminder_create', segment: 'Erinnere mich am 15.11.2026', reminder: { remindAt: '2026-11-15', title: 'Feedback zum Konferenzbeitrag' } });
  const multi = (...intents: unknown[]) => ({ intents });

  it('speichert eine unsichere Entscheidung nicht ungefragt, setzt die weitere Absicht danach fort und legt bei „Notiz“ nur eine Notiz an', async () => {
    app.llm.on('ChatIntent', () => multi(decisionUnsure(), reminder()));
    const r1 = await app.ok('chat:send', { text: msg });
    expect(r1.assistantMessage.content).toMatch(/nicht sicher, ob das eine getroffene \*\*Entscheidung\*\*/);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect(await app.ok('reminders:list', {})).toHaveLength(0); // wartet bis zur Antwort

    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' })); // die Antwort wird nicht per LLM ausgewertet
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Nur als Notiz' });
    expect(r2.assistantMessage.content).toMatch(/^Notiz gespeichert/);
    // die Notiz enthält wirklich den Abschnitt zur unsicheren Entscheidung (nicht nur die Erinnerung)
    expect((await app.ok('search:global', { query: 'eingereicht', limit: 5 })).some((h) => h.type === 'note')).toBe(true);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect((await app.ok('reminders:list', {}))[0]).toMatchObject({ remindAt: '2026-11-15' });
    expect((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'note')).toBe(true);
  });

  it('erfasst die Entscheidung erst nach ausdrücklicher Bestätigung, „nichts speichern“ verwirft sie', async () => {
    app.llm.on('ChatIntent', () => multi(decisionUnsure()));
    const r1 = await app.ok('chat:send', { text: msg });
    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Ja, als Entscheidung' });
    expect(r2.assistantMessage.content).toMatch(/Wer war an der Entscheidung beteiligt|Entscheidung/);
    expect(await app.ok('decisions:list', {})).toHaveLength(1);

    app.llm.on('ChatIntent', () => multi(decisionUnsure()));
    const r3 = await app.ok('chat:send', { text: 'Wir sollten vielleicht den Anbieter wechseln.' });
    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r4 = await app.ok('chat:send', { conversationId: r3.conversationId, text: 'nichts speichern' });
    expect(r4.assistantMessage.content).toMatch(/nichts/);
    expect(await app.ok('decisions:list', {})).toHaveLength(1);
  });

  it('führt mehrere eindeutige Absichten einer Nachricht nacheinander aus und fasst die Antwort zusammen', async () => {
    app.llm.on('ChatIntent', () =>
      multi(
        intent({ intent: 'note_capture', segment: 'Notiz', note: 'Stackit-PoC läuft seit Mai.' }),
        intent({
          intent: 'open_item_new',
          segment: 'offener Punkt',
          openItem: { title: 'PoC im ACT-Team vorstellen', dueAt: '2026-10-31', responsible: 'Anna' },
        }),
        intent({ intent: 'reminder_create', segment: 'Erinnerung', reminder: { remindAt: '2026-10-30', title: 'PoC vorbereiten' } }),
      ),
    );
    const r = await app.ok('chat:send', { text: 'Notiz: Stackit-PoC läuft seit Mai. Offen: PoC im ACT-Team vorstellen bis 31.10. Erinnere mich am 30.10.' });
    expect(r.assistantMessage.content).toMatch(/Notiz gespeichert/);
    expect(r.assistantMessage.content).toMatch(/PoC im ACT-Team vorstellen/);
    expect((await app.ok('openItems:list', {})).length).toBeGreaterThanOrEqual(1);
    expect((await app.ok('reminders:list', {})).length).toBeGreaterThanOrEqual(1);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
  });

  it('stellt eine Rückfrage statt zu raten, wenn die Absicht unklar ist', async () => {
    app.llm.on('ChatIntent', () => ({
      intents: [intent({ intent: 'unknown', confidence: 0.2 })],
      clarification: 'Meinst du, dass ich Nordlicht archivieren oder pausieren soll?',
    }));
    const r = await app.ok('chat:send', { text: 'Mach das mit Nordlicht.' });
    expect(r.assistantMessage.content).toContain('archivieren oder pausieren');
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
  });
});

describe('Optionale Rückfrage zum offenen Punkt hält weitere Absichten nicht auf (#41)', () => {
  it('legt die Erinnerung sofort an; die Antwort auf die Rückfrage ergänzt danach den Punkt', async () => {
    let n = 0;
    app.llm.on('ChatIntent', () => {
      n += 1;
      if (n > 1) return { intents: [intent({ intent: 'open_item_update', openItem: { responsible: 'Anna', dueAt: '2026-10-31' } })] };
      return {
        intents: [
          intent({ intent: 'open_item_new', segment: 'offener Punkt', openItem: { title: 'PoC vorstellen' } }),
          intent({ intent: 'reminder_create', segment: 'Erinnerung', reminder: { remindAt: '2026-10-30', title: 'PoC vorbereiten' } }),
        ],
      };
    });
    const r1 = await app.ok('chat:send', { text: 'Offen: PoC vorstellen. Erinnere mich am 30.10. an die Vorbereitung.' });
    expect(r1.assistantMessage.content).toMatch(/Wer ist verantwortlich/);
    expect(r1.assistantMessage.content).not.toContain('Danach erledige ich noch');
    expect(await app.ok('reminders:list', {})).toHaveLength(1);
    await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Anna, bis 31.10.' });
    const poc = (await app.ok('openItems:list', {})).find((i) => i.title === 'PoC vorstellen')!;
    expect(poc.responsibleName).toBe('Anna');
    expect(poc.dueAt?.slice(0, 10)).toBe('2026-10-31');
  });
});

describe('Ereignisse in der Timeline', () => {
  const ev = (over: Record<string, unknown> = {}) =>
    intent({
      intent: 'event_record',
      segment: 'am 01.10.2026 eingereicht',
      event: { title: 'Beitrag beim German Testing Day eingereicht', occurredAt: '2026-10-01' },
      topic: 'Konferenzbeitrag',
      ...over,
    });

  it('trägt ein Ereignis mit Datum direkt ein, es erscheint in Timeline und Suche und lässt sich nur bestätigt löschen', async () => {
    app.llm.on('ChatIntent', () => ({ intents: [ev()] }));
    const r = await app.ok('chat:send', { text: 'Ich habe den Beitrag am 01.10.2026 beim German Testing Day eingereicht.' });
    expect(r.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    const events = await app.ok('events:list', {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ occurredAt: expect.stringMatching(/^2026-10-01/), topicName: 'Konferenzbeitrag' });
    const entry = (await app.ok('timeline:get', {})).find((e) => e.kind === 'event');
    expect(entry).toMatchObject({ date: '2026-10-01', title: expect.stringContaining('German Testing Day') });
    expect((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'event')).toBe(true);
    await app.ok('events:delete', { id: events[0]!.id, confirmed: true });
    expect(await app.ok('events:list', {})).toHaveLength(0);
    expect((await app.ok('timeline:get', {})).some((e) => e.kind === 'event')).toBe(false);
  });

  it('fragt nach dem Datum, wenn es fehlt, und merkt sich das Ereignis bis zur Antwort', async () => {
    app.llm.on('ChatIntent', () => ({ intents: [ev({ segment: 'Beitrag eingereicht', event: { title: 'Beitrag eingereicht', occurredAt: null } })] }));
    const r1 = await app.ok('chat:send', { text: 'Ich habe den Beitrag eingereicht.' });
    expect(r1.assistantMessage.content).toMatch(/An welchem Datum/);
    expect(await app.ok('events:list', {})).toHaveLength(0);
    app.llm.on('ChatIntent', () => ({ intents: [ev({ event: { title: 'Beitrag eingereicht', occurredAt: '2026-10-01' } })] }));
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Am 1. Oktober 2026' });
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('events:list', {})).toHaveLength(1);
  });

  it('bietet bei unsicherer Entscheidung auch „Ereignis“ an und legt es bei dieser Antwort an', async () => {
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({
          intent: 'decision_new',
          segment: 'am 01.10.2026 eingereicht',
          decisionCertainty: 'unsure',
          decision: decisionEx({ decisionText: 'Beitrag eingereicht.', title: 'Beitrag eingereicht', decidedAt: '2026-10-01' }),
        }),
      ],
    }));
    const r1 = await app.ok('chat:send', { text: 'Ich habe am 01.10.2026 den Beitrag eingereicht.' });
    expect(r1.assistantMessage.content).toMatch(/Ereignis/);
    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Als Ereignis' });
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect((await app.ok('events:list', {}))[0]).toMatchObject({ occurredAt: expect.stringMatching(/^2026-10-01/) });
  });

  it('legt Ereignisse auch manuell an', async () => {
    const e = await app.ok('events:create', { title: 'Kickoff', occurredAt: '2026-03-03', project: 'Nordlicht', sourceIds: [] });
    expect(e.projectName).toBe('Nordlicht');
    await expect(app.call('events:create', { title: 'x', occurredAt: 'kein Datum', sourceIds: [] })).resolves.toMatchObject({ ok: false });
  });
});
