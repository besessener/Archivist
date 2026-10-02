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

describe('Open follow-up questions do not block or hijack later messages (#42)', () => {
  it('an old follow-up question about the open item does not hold up the note and reminder of the next message', async () => {
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
    // the follow-up question only applies to the next message
    const r3 = await send('Anna', r1.conversationId);
    expect((await app.ok('openItems:list', {})).find((i) => i.id === poc.id)!.responsibleName).toBeNull();
    expect(r3.assistantMessage.intent).not.toBe('open_item_update');
  });

  it('a new event never takes over the title or target of an old follow-up question', async () => {
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

  it('a new reminder with its own title does not answer the date question of another one', async () => {
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

  it('without an LLM „ja“ does not become the responsible person', async () => {
    app.llm.down = true;
    const r1 = await send('Offener Punkt: Angebot prüfen');
    expect(r1.assistantMessage.content).toMatch(/Wer ist verantwortlich/);

    await send('ja', r1.conversationId);

    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.responsibleName).toBeNull();
    expect(app.services.graph.findByName('person', 'ja')).toBeFalsy();
  });

  it('without an LLM only a short, matching answer counts; „Anna, bis 20.10.“ sets both', async () => {
    app.llm.down = true;
    const r1 = await send('Offener Punkt: Angebot prüfen');
    await send('Anna, bis 20.10.2026', r1.conversationId);
    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.responsibleName).toBe('Anna');
    expect(item.dueAt?.slice(0, 10)).toBe('2026-10-20');
  });

  it('without an LLM a decision follow-up question does not hijack an unrelated message', async () => {
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

  it('deferred intents keep their original text after „Entscheidung oder Notiz?“', async () => {
    const text = 'Vielleicht wechseln wir den Anbieter. Merk dir: der Vertrag läuft bis März.';
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({
          intent: 'decision_new',
          segment: 'Vielleicht wechseln wir den Anbieter.',
          decisionCertainty: 'unsure',
          decision: decisionEx({ decisionText: 'Anbieter wechseln', title: 'Anbieter wechseln' }),
        }),
        // without a note field: the note is created from the text
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

  it('a message that does not answer the follow-up question does not discard the deferred requests', async () => {
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

  it('the LLM is told that a follow-up question is only answered by a matching message', async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'reminder_create', reminder: { title: 'Treffen' } }));
    const r1 = await send('Erinnere mich an das Treffen');
    await send('Wie spät ist es?', r1.conversationId);
    const second = app.llm.calls.filter((c) => c.schema === 'ChatIntent')[1]!;
    expect(second.input).toContain('KANN die Antwort darauf sein');
    expect(second.input).not.toContain('sehr wahrscheinlich');
  });
});
