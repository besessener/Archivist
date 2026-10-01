import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const decisionEx = (over: Record<string, unknown> = {}) => ({ participants: [], alternatives: [], unknownFields: [], confidence: 0.85, ...over });
const userText = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? '';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

describe('Offene Rückfragen blockieren oder kapern keine späteren Nachrichten (#42)', () => {
  it('eine alte Rückfrage zum offenen Punkt hält Notiz und Erinnerung der nächsten Nachricht nicht auf', async () => {
    app.llm.on('ChatIntent', (_s, input) => {
      if (/^Offen: PoC/.test(userText(input))) return intent({ intent: 'open_item_new', openItem: { title: 'PoC vorstellen' } });
      return {
        intents: [
          intent({ intent: 'note_capture', segment: 'Notiz A.', note: 'Notiz A' }),
          intent({ intent: 'reminder_create', segment: 'Erinnere mich am 15.11. an Steuer', reminder: { remindAt: '2026-11-15', title: 'Steuer' } }),
        ],
      };
    });
    const r1 = await send('Offen: PoC vorstellen');
    expect(r1.assistantMessage.content).toMatch(/Wer ist verantwortlich/);

    const r2 = await send('Notiz A. Erinnere mich am 15.11. an Steuer', r1.conversationId);

    expect(r2.assistantMessage.content).toContain('Notiz gespeichert');
    expect(r2.assistantMessage.content).toContain('Erinnerung für den 2026-11-15 angelegt');
    expect(await app.ok('reminders:list', {})).toHaveLength(1);
    const poc = (await app.ok('openItems:list', {})).find((i) => i.title === 'PoC vorstellen')!;
    // die Rückfrage gilt nur für die nächste Nachricht
    const r3 = await send('Anna', r1.conversationId);
    expect((await app.ok('openItems:list', {})).find((i) => i.id === poc.id)!.responsibleName).toBeNull();
    expect(r3.assistantMessage.intent).not.toBe('open_item_update');
  });

  it('ein neues Ereignis übernimmt nie Titel oder Ziel einer alten Rückfrage', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Kickoff/.test(userText(input))
        ? intent({ intent: 'event_record', event: { title: 'Kickoff mit Kunde', occurredAt: null } })
        : intent({ intent: 'event_record', event: { title: 'Release 2.0 veröffentlicht', occurredAt: '2026-10-05' } }),
    );
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    expect(r1.assistantMessage.content).toMatch(/An welchem Datum war das Ereignis „Kickoff mit Kunde“/);

    const r2 = await send('Release 2.0 wurde am 05.10. veröffentlicht', r1.conversationId);

    const events = await app.ok('events:list', {});
    expect(events.map((e) => e.title)).toEqual(['Release 2.0 veröffentlicht']);
    expect(r2.assistantMessage.content).toMatch(/Hinweis: Das Ereignis „Kickoff mit Kunde“ habe ich ohne Datum nicht eingetragen/);
  });

  it('eine neue Erinnerung mit eigenem Titel beantwortet nicht die Frage nach dem Datum einer anderen', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Treffen/.test(userText(input))
        ? intent({ intent: 'reminder_create', reminder: { title: 'Treffen mit dem Team' } })
        : intent({ intent: 'reminder_create', reminder: { title: 'Zahnarzt anrufen', remindAt: '2026-11-15' } }),
    );
    const r1 = await send('Erinnere mich an das Treffen mit dem Team');
    await send('Erinnere mich am 15.11. an den Zahnarzt', r1.conversationId);

    const reminders = await app.ok('reminders:list', {});
    expect(reminders.map((r) => r.title)).toEqual(['Zahnarzt anrufen']);
  });

  it('ohne LLM wird „ja“ nicht zur verantwortlichen Person', async () => {
    app.llm.down = true;
    const r1 = await send('Offener Punkt: Angebot prüfen');
    expect(r1.assistantMessage.content).toMatch(/Wer ist verantwortlich/);

    await send('ja', r1.conversationId);

    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.responsibleName).toBeNull();
    expect(app.services.graph.findByName('person', 'ja')).toBeFalsy();
  });

  it('ohne LLM gilt nur eine kurze, passende Antwort; „Anna, bis 20.10.“ setzt beides', async () => {
    app.llm.down = true;
    const r1 = await send('Offener Punkt: Angebot prüfen');
    await send('Anna, bis 20.10.2026', r1.conversationId);
    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.responsibleName).toBe('Anna');
    expect(item.dueAt?.slice(0, 10)).toBe('2026-10-20');
  });

  it('ohne LLM kapert eine Entscheidungs-Rückfrage keine fremde Nachricht', async () => {
    app.llm.down = true;
    const r1 = await send('Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.');
    expect(r1.assistantMessage.content).toContain('Wann wurde das entschieden?');

    const r2 = await send('Erinnere mich am 15.11.2026 an die Steuer', r1.conversationId);

    expect(r2.assistantMessage.content).toContain('Erinnerung für den 2026-11-15 angelegt');
    expect(r2.assistantMessage.content).toMatch(/bleibt als Entwurf gespeichert/);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.status).toBe('draft');
    expect(d.decidedAt).toBeNull();
  });

  it('zurückgestellte Absichten behalten nach „Entscheidung oder Notiz?“ ihren Originaltext', async () => {
    const text = 'Vielleicht wechseln wir den Anbieter. Merk dir: der Vertrag läuft bis März.';
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({
          intent: 'decision_new',
          segment: 'Vielleicht wechseln wir den Anbieter.',
          decisionCertainty: 'unsure',
          decision: decisionEx({ decisionText: 'Anbieter wechseln', title: 'Anbieter wechseln' }),
        }),
        // ohne note-Feld: die Notiz entsteht aus dem Text
        intent({ intent: 'note_capture', segment: 'der Vertrag läuft bis März' }),
      ],
    }));
    const r1 = await send(text);
    expect(r1.assistantMessage.content).toMatch(/nicht sicher/);
    expect(r1.assistantMessage.content).toMatch(/Danach erledige ich noch:\n• Notiz: „der Vertrag läuft bis März“/);

    const r2 = await send('nichts speichern', r1.conversationId);

    expect(r2.assistantMessage.errorMessage).toBeNull();
    expect(r2.assistantMessage.content).toContain('Notiz gespeichert');
    const hits = await app.ok('search:global', { query: 'Vertrag läuft bis März', limit: 5 });
    expect(hits.some((h) => h.type === 'note')).toBe(true);
  });

  it('eine Nachricht, die die Rückfrage nicht beantwortet, verwirft die zurückgestellten Anliegen nicht', async () => {
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({
          intent: 'decision_new',
          segment: 'Anbieter wechseln',
          decisionCertainty: 'unsure',
          decision: decisionEx({ decisionText: 'Anbieter wechseln' }),
        }),
        intent({ intent: 'reminder_create', segment: 'Erinnere mich am 30.10.', reminder: { remindAt: '2026-10-30', title: 'Anbieter vergleichen' } }),
      ],
    }));
    const r1 = await send('Vielleicht wechseln wir den Anbieter. Erinnere mich am 30.10. ans Vergleichen.');
    expect(await app.ok('reminders:list', {})).toHaveLength(0);

    app.llm.on('ChatIntent', () => intent({ intent: 'archive_status' }));
    const r2 = await send('Wie viele Dokumente gibt es?', r1.conversationId);

    expect(r2.assistantMessage.content).toContain('Archivstatus');
    expect(r2.assistantMessage.content).toMatch(/Hinweis: Zu „Anbieter wechseln“ habe ich nichts gespeichert/);
    expect((await app.ok('reminders:list', {})).map((r) => r.title)).toEqual(['Anbieter vergleichen']);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
  });

  it('der LLM erfährt, dass eine Rückfrage nur bei passender Nachricht beantwortet wird', async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'reminder_create', reminder: { title: 'Treffen' } }));
    const r1 = await send('Erinnere mich an das Treffen');
    await send('Wie spät ist es?', r1.conversationId);
    const second = app.llm.calls.filter((c) => c.schema === 'ChatIntent')[1]!;
    expect(second.input).toContain('KANN die Antwort darauf sein');
    expect(second.input).not.toContain('sehr wahrscheinlich');
  });
});
