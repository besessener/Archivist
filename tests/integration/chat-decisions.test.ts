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

describe('Decision workflow with follow-up questions (LLM)', () => {
  it('asks targeted follow-up questions, saves only when complete and finds the decision again', async () => {
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

  it('saves fields that were explicitly confirmed as unknown', async () => {
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

describe('Decision workflow without an LLM (rule-based fallback)', () => {
  it('asks step by step and points out the missing LLM', async () => {
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

  it('returns a local hit list with sources for knowledge questions without an LLM', async () => {
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

  it('openly admits when nothing was found', async () => {
    const r = await app.ok('chat:send', { text: 'Haben wir jemals über Vault gesprochen?' });
    expect(r.assistantMessage.content).toMatch(/nichts/);
    expect(r.assistantMessage.sources).toHaveLength(0);
  });
});

describe('Contradictions and replacing only after confirmation', () => {
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

  it('detects two contradicting decisions, shows insight + hint and replaces only after confirmation', async () => {
    app.llm.down = true; // purely lexical check with controlled sample data
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

    // no autonomous change
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');

    // rejected without confirmation
    const denied = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: false as unknown as true, strongConfirmed: false });
    expect(denied.ok).toBe(false);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');

    await app.ok('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });
    const old = await app.ok('decisions:get', { id: a.id });
    expect(old.status).toBe('superseded');
    expect((await app.ok('decisions:get', { id: b.id })).supersedesDecisionId).toBe(a.id);

    // undo first checks for newer changes
    const audit = await app.ok('audit:list', { limit: 50, onlyUndoable: true });
    const entry = audit.find((e) => e.action === 'decision.supersede')!;
    await app.ok('decisions:update', { id: a.id, patch: { rationale: 'nachträglich ergänzt' } });
    const blocked = await app.ok('audit:undo', { auditId: entry.id });
    expect(blocked.undone).toBe(false);
    expect(blocked.conflicts.join(' ')).toMatch(/verändert/);
  });

  it('undo restores the status when nothing was changed', async () => {
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

  it('shows the replace proposal in the chat when a new decision contradicts', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir prod-plat pausieren. Datum 01.03.2026.' });
    // rule-based: date detected, topic prod-plat detected, participants missing → follow-up question
    expect(r.assistantMessage.content).toContain('Wer war an der Entscheidung beteiligt?');
    const r2 = await app.ok('chat:send', { conversationId: r.conversationId, text: 'Anna' });
    expect(r2.assistantMessage.content).toMatch(/Widerspruch|widersprüchlich/);
    expect(r2.assistantMessage.actions.some((x) => x.actionType === 'supersede_decision' && x.status === 'proposed')).toBe(true);
  });
});

describe('Open items, reminders and notification bell', () => {
  it('creates an open item, asks for missing details, reminds and closes only after confirmation', async () => {
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

    // reminder becomes due → notification bell
    app.services.ctx.database.sqlite.prepare('UPDATE reminders SET remind_at = ?').run('2020-01-01');
    expect(app.services.reminders.checkDue()).toBe(1);
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((x) => x.type === 'reminder' && x.title.includes('Finanzierungszusage'))).toBe(true);
    expect((await app.ok('app:getStatus', {})).unreadNotifications).toBeGreaterThan(0);

    // closing: only a proposal until confirmed
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

  it('reports overdue open items during the archive check', async () => {
    app.llm.down = true;
    await app.ok('openItems:create', { title: 'Steuerbescheid prüfen', dueAt: '2020-01-01', priority: 'normal', sourceIds: [], confidence: 0.9 });
    await app.services.consistency.run('test');
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((n) => n.type === 'open_item_overdue')).toBe(true);
    expect(notes.some((n) => n.type === 'open_item_no_owner')).toBe(true);
  });
});

describe('Invalid LLM outputs trigger nothing', () => {
  it('discards answers that do not match the schema and changes nothing', async () => {
    app.llm.on('ChatIntent', () => ({ intent: 'decision_new', confidence: 7, decision: { participants: 'Anna' } }));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, X zu tun.' });
    // falls back to rule-based evaluation and visibly flags the technical error
    expect(r.assistantMessage.errorMessage).toMatch(/Format/);
    const calls = app.llm.calls.filter((c) => c.schema === 'ChatIntent');
    expect(calls.length).toBe(2); // one correction request
    expect(calls[1]!.input).toContain('ungültig');
  });

  it('accepts a corrected answer on the second attempt', async () => {
    let k = 0;
    app.llm.on('ChatIntent', () => (++k === 1 ? 'das ist kein json' : intent({ intent: 'smalltalk' })));
    const r = await app.ok('chat:send', { text: 'Hallo' });
    expect(r.assistantMessage.errorMessage).toBeNull();
    expect(k).toBe(2);
  });

  it('rejects actions with invalid parameters', () => {
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

describe('Follow-up question about the reminder date keeps the context', () => {
  const note = 'Bezüglich AI und Stackit hatten wir ein Mini-Projekt. Es wurde noch nicht im ACT-Team vorgestellt. Dafür bräuchte ich eine Erinnerung.';

  it('understands „31.10.“ as the answer to „Wann soll ich dich erinnern?“ (with LLM)', async () => {
    let n = 0;
    app.llm.on('ChatIntent', (_s, input) => {
      n += 1;
      // the LLM is told about the open follow-up question
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
    // the reminder yields an open item (with due date) and a note – both appear in timeline and search
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

  it('also works without an LLM and expires after an unrelated message', async () => {
    app.llm.down = true;
    const r1 = await app.ok('chat:send', { text: 'Erinnere mich bitte an das Treffen mit dem Team.' });
    expect(r1.assistantMessage.content).toContain('Wann soll ich dich erinnern?');
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '31.10.' });
    expect(r2.assistantMessage.content).toContain('angelegt');
    expect((await app.ok('reminders:list', {}))[0]!.title).toMatch(/Treffen mit dem Team/);

    const r3 = await app.ok('chat:send', { text: 'Erinnere mich an die Steuererklärung.' });
    await app.ok('chat:send', { conversationId: r3.conversationId, text: 'Wie viele Dokumente gibt es?' });
    const r5 = await app.ok('chat:send', { conversationId: r3.conversationId, text: '15.11.' });
    expect(r5.assistantMessage.content).not.toContain('angelegt'); // the follow-up question is no longer open
    expect(await app.ok('reminders:list', {})).toHaveLength(1);
  });
});

describe('Renaming conversations', () => {
  it('changes only the title, sanitizes input and rejects empty values', async () => {
    app.llm.down = true;
    const r = await app.ok('chat:send', { text: 'Hallo Archivist' });
    const renamed = await app.ok('chat:renameConversation', { id: r.conversationId, title: '  Konferenz   Beitrag  ' });
    expect(renamed.title).toBe('Konferenz Beitrag');
    expect((await app.ok('chat:conversations', {}))[0]!.title).toBe('Konferenz Beitrag');
    expect((await app.ok('chat:history', { conversationId: r.conversationId })).length).toBe(2);
    // the new title is not overwritten by later messages
    await app.ok('chat:send', { conversationId: r.conversationId, text: 'Noch eine Nachricht' });
    expect((await app.ok('chat:conversations', {}))[0]!.title).toBe('Konferenz Beitrag');
    expect((await app.call('chat:renameConversation', { id: r.conversationId, title: '   ' })).ok).toBe(false);
    expect((await app.call('chat:renameConversation', { id: 'gibt-es-nicht', title: 'x' })).ok).toBe(false);
  });
});

describe('Multiple intents and follow-up questions under uncertainty', () => {
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

  it('does not save an uncertain decision without asking, continues the further intent afterwards and creates only a note for „Notiz“', async () => {
    app.llm.on('ChatIntent', () => multi(decisionUnsure(), reminder()));
    const r1 = await app.ok('chat:send', { text: msg });
    expect(r1.assistantMessage.content).toMatch(/nicht sicher, ob das eine getroffene \*\*Entscheidung\*\*/);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect(await app.ok('reminders:list', {})).toHaveLength(0); // waits for the answer

    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' })); // the answer is not evaluated by the LLM
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Nur als Notiz' });
    expect(r2.assistantMessage.content).toMatch(/^Notiz gespeichert/);
    // the note really contains the section on the uncertain decision (not just the reminder)
    expect((await app.ok('search:global', { query: 'eingereicht', limit: 5 })).some((h) => h.type === 'note')).toBe(true);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect((await app.ok('reminders:list', {}))[0]).toMatchObject({ remindAt: '2026-11-15' });
    expect((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'note')).toBe(true);
  });

  it('records the decision only after explicit confirmation; „nichts speichern“ discards it', async () => {
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

  it('executes several unambiguous intents of one message in sequence and summarizes the answer', async () => {
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

  it('asks a follow-up question instead of guessing when the intent is unclear', async () => {
    app.llm.on('ChatIntent', () => ({
      intents: [intent({ intent: 'unknown', confidence: 0.2 })],
      clarification: 'Meinst du, dass ich Nordlicht archivieren oder pausieren soll?',
    }));
    const r = await app.ok('chat:send', { text: 'Mach das mit Nordlicht.' });
    expect(r.assistantMessage.content).toContain('archivieren oder pausieren');
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
  });
});

describe('Optional follow-up question about the open item does not hold up further intents (#41)', () => {
  it('creates the reminder immediately; the answer to the follow-up question then completes the item', async () => {
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

describe('Events in the timeline', () => {
  const ev = (over: Record<string, unknown> = {}) =>
    intent({
      intent: 'event_record',
      segment: 'am 01.10.2026 eingereicht',
      event: { title: 'Beitrag beim German Testing Day eingereicht', occurredAt: '2026-10-01' },
      topic: 'Konferenzbeitrag',
      ...over,
    });

  it('records an event with a date directly; it appears in timeline and search and can only be deleted with confirmation', async () => {
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

  it('asks for the date when it is missing and remembers the event until the answer', async () => {
    app.llm.on('ChatIntent', () => ({ intents: [ev({ segment: 'Beitrag eingereicht', event: { title: 'Beitrag eingereicht', occurredAt: null } })] }));
    const r1 = await app.ok('chat:send', { text: 'Ich habe den Beitrag eingereicht.' });
    expect(r1.assistantMessage.content).toMatch(/An welchem Datum/);
    expect(await app.ok('events:list', {})).toHaveLength(0);
    app.llm.on('ChatIntent', () => ({ intents: [ev({ event: { title: 'Beitrag eingereicht', occurredAt: '2026-10-01' } })] }));
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Am 1. Oktober 2026' });
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('events:list', {})).toHaveLength(1);
  });

  it('also offers „Ereignis“ for an uncertain decision and creates it on that answer', async () => {
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

  it('also creates events manually', async () => {
    const e = await app.ok('events:create', { title: 'Kickoff', occurredAt: '2026-03-03', project: 'Nordlicht', sourceIds: [] });
    expect(e.projectName).toBe('Nordlicht');
    await expect(app.call('events:create', { title: 'x', occurredAt: 'kein Datum', sourceIds: [] })).resolves.toMatchObject({ ok: false });
  });
});

describe('References in the chat lead to the right object', () => {
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

  it('returns the reminder as a source of type "reminder" (not as a note)', async () => {
    app.llm.down = true;
    const r1 = await app.ok('chat:send', { text: 'Erinnere mich bitte an das Treffen mit dem Team.' });
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '31.10.' });
    const rem = (await app.ok('reminders:list', {}))[0]!;
    expect(r2.assistantMessage.sources.find((s) => s.id === rem.id)?.type).toBe('reminder');
    // the type is preserved when read from the stored history too
    const history = await app.ok('chat:history', { conversationId: r1.conversationId });
    expect(history.at(-1)!.sources.find((s) => s.id === rem.id)?.type).toBe('reminder');
  });

  it('marks contradictions in the context as "contradiction" – after a new decision and during the check', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir prod-plat pausieren. Datum 01.03.2026.' });
    const r2 = await app.ok('chat:send', { conversationId: r.conversationId, text: 'Anna' });
    const contra = await app.ok('contradictions:list', {});
    expect(contra.length).toBeGreaterThan(0);
    const fromDecision = r2.assistantMessage.context?.contradictions ?? [];
    expect(fromDecision.length).toBeGreaterThan(0);
    expect(fromDecision.every((c) => c.type === 'contradiction' && contra.some((x) => x.id === c.id))).toBe(true);

    const check = await app.ok('chat:send', { text: 'gibt es widersprüche?' });
    expect(check.assistantMessage.intent).toBe('contradiction_check');
    const fromCheck = check.assistantMessage.context?.contradictions ?? [];
    expect(fromCheck.map((c) => c.id).sort()).toEqual(contra.map((c) => c.id).sort());
    expect(fromCheck.every((c) => c.type === 'contradiction')).toBe(true);
  });

  it('links contradictions in the timeline to the contradiction itself', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    await app.ok('decisions:create', mk('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01'));
    const [contra] = await app.ok('contradictions:list', {});
    const entry = (await app.ok('timeline:get', {})).find((e) => e.kind === 'contradiction')!;
    expect(entry.refs[0]).toMatchObject({ type: 'contradiction', id: contra!.id });
    expect(entry.refs.slice(1).every((x) => x.type === 'decision')).toBe(true);

    const r = await app.ok('chat:send', { text: 'Zeig mir den Zeitverlauf' });
    expect(r.assistantMessage.intent).toBe('timeline_query');
    expect(r.assistantMessage.sources.find((s) => s.id === contra!.id)?.type).toBe('contradiction');
    expect((r.assistantMessage.context?.contradictions ?? []).map((c) => c.id)).toContain(contra!.id);
  });
});

describe('An addition without a running follow-up question (#177)', () => {
  it('changes the last decision instead of creating a new one from the addition sentence', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Ben war übrigens auch dabei/.test(input)
        ? intent({ intent: 'decision_amend', decision: decisionEx({ participants: ['Ben'] }) })
        : intent({
            intent: 'decision_new',
            decision: decisionEx({
              decisionText: 'Wir wechseln zum Stromanbieter B.',
              decidedAt: '2026-03-03',
              topic: 'Strom',
              topicIsProject: false,
              participants: ['Anna'],
            }),
          }),
    );
    const r1 = await app.ok('chat:send', { text: 'Wir haben am 3.3.2026 entschieden, zum Stromanbieter B zu wechseln. Anna war dabei.' });
    const [first] = await app.ok('decisions:list', {});
    expect(first!.status).toBe('active');

    await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Ben war übrigens auch dabei.' });

    const all = await app.ok('decisions:list', {});
    expect(all).toHaveLength(1);
    expect(all[0]!.participants).toEqual(expect.arrayContaining(['Anna', 'Ben']));
    expect(all[0]!.decisionText).toBe('Wir wechseln zum Stromanbieter B.');
  });

  it('asks what to add when the addition names nothing that can be stored', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Noch was dazu/.test(input)
        ? intent({ intent: 'decision_amend', decision: decisionEx() })
        : intent({
            intent: 'decision_new',
            decision: decisionEx({
              decisionText: 'Wir wechseln zu B.',
              decidedAt: '2026-03-03',
              topic: 'Strom',
              topicIsProject: false,
              participants: ['Anna'],
            }),
          }),
    );
    const r1 = await app.ok('chat:send', { text: 'Wir haben entschieden, zu B zu wechseln.' });
    const r = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Noch was dazu.' });
    expect(r.assistantMessage.content).toMatch(/Was soll ich an der Entscheidung/);
    expect(await app.ok('decisions:list', {})).toHaveLength(1);
  });
});
