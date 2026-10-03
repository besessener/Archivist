import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { extractedDecision, intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
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
    await app.services.consistency.run({ trigger: 'test' });
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((n) => n.type === 'open_item_overdue')).toBe(true);
    expect(notes.some((n) => n.type === 'open_item_no_owner')).toBe(true);
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
      decision: extractedDecision({
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
