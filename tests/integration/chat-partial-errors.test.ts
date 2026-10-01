import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const userText = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? '';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });
interface Internals {
  droppedHint: () => string | null;
  classify: () => Promise<unknown>;
}

const notes = () => app.services.graph.listEntities({ type: 'note' });

describe('Fehler mitten in einer Nachricht: Teilergebnisse bleiben erhalten (#50)', () => {
  beforeEach(() => {
    app.llm.on('ChatIntent', (_s, input) => {
      const t = userText(input);
      if (/Kickoff/.test(t)) return intent({ intent: 'event_record', event: { title: 'Kickoff mit Kunde', occurredAt: null } });
      if (/Notiz/.test(t))
        return {
          intents: [
            intent({ intent: 'note_capture', segment: 'Notiz: Server läuft wieder.', note: 'Server läuft wieder' }),
            intent({ intent: 'open_item_new', segment: 'Offen: Backup prüfen', openItem: { title: 'Backup prüfen' } }),
          ],
        };
      return intent({ intent: 'smalltalk' });
    });
  });

  it('zwei Anliegen, das zweite scheitert: Notiz bleibt, Antwort nennt beides, alter Zustand ist weg', async () => {
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    expect(r1.assistantMessage.content).toMatch(/An welchem Datum war das Ereignis „Kickoff mit Kunde“/);
    vi.spyOn(app.services.openItems, 'create').mockImplementation(() => {
      throw new Error('kaputt');
    });

    const r2 = await send('Notiz: Server läuft wieder. Offen: Backup prüfen', r1.conversationId);

    expect(notes().map((n) => n.name)).toEqual(['Server läuft wieder']);
    expect(await app.ok('openItems:list', {})).toHaveLength(0);
    const reply = r2.assistantMessage;
    // Erledigtes und Fehlgeschlagenes stehen beide in der Antwort – ein erneutes Senden ist für die Notiz nicht nötig
    expect(reply.content).toContain('Notiz gespeichert');
    expect(reply.content).toContain('Das hat nicht geklappt: offener Punkt: „Offen: Backup prüfen“ – Unerwarteter Fehler.');
    expect(reply.content).not.toContain('Das konnte ich nicht verarbeiten');
    expect(reply.errorMessage).toContain('kaputt');
    expect(reply.intent).toBe('note_capture');
    expect(reply.sources.some((s) => s.type === 'note')).toBe(true);
    // die alte Rückfrage nach dem Datum ist nicht wiederhergestellt
    expect(reply.content).toMatch(/Hinweis: Das Ereignis „Kickoff mit Kunde“ habe ich ohne Datum nicht eingetragen/);
    await send('Hallo', r1.conversationId);
    const last = app.llm.calls.filter((c) => c.schema === 'ChatIntent').at(-1)!;
    expect(last.input).toContain('Offene Rückfrage: keine');
  });

  it('scheitert das einzige Anliegen, bleibt keine halb gesetzte Rückfrage zurück', async () => {
    vi.spyOn(app.services.openItems, 'create').mockImplementation(() => {
      throw new Error('kaputt');
    });
    app.llm.on('ChatIntent', (_s, input) =>
      /Backup/.test(userText(input)) ? intent({ intent: 'open_item_new', openItem: { title: 'Backup prüfen' } }) : intent({ intent: 'smalltalk' }),
    );

    const r1 = await send('Offen: Backup prüfen');

    expect(r1.assistantMessage.content).toBe('Das hat nicht geklappt: offener Punkt – Unerwarteter Fehler.');
    expect(r1.assistantMessage.errorMessage).toContain('kaputt');
    await send('Hallo', r1.conversationId);
    const last = app.llm.calls.filter((c) => c.schema === 'ChatIntent').at(-1)!;
    expect(last.input).toContain('Offene Rückfrage: keine');
  });

  it('ein Fehler außerhalb der einzelnen Anliegen behält bereits Erledigtes in Antwort und Zustand', async () => {
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    // der Hinweis auf die verworfene Rückfrage entsteht erst nach den Anliegen – scheitert er, ist die Notiz schon gespeichert
    vi.spyOn(app.services.chat as unknown as Internals, 'droppedHint').mockImplementation(() => {
      throw new Error('Hinweis kaputt');
    });

    const r2 = await send('Notiz: Server läuft wieder. Offen: Backup prüfen', r1.conversationId);

    expect(notes()).toHaveLength(1);
    expect(await app.ok('openItems:list', {})).toHaveLength(1);
    expect(r2.assistantMessage.content).toContain('Notiz gespeichert');
    expect(r2.assistantMessage.content).toContain('Das konnte ich nicht verarbeiten: Unerwarteter Fehler.');
    expect(r2.assistantMessage.errorMessage).toContain('Hinweis kaputt');
    vi.restoreAllMocks();
    await send('Hallo', r1.conversationId);
    const last = app.llm.calls.filter((c) => c.schema === 'ChatIntent').at(-1)!;
    // der Zustand entspricht dem Erledigten: die Rückfrage zum offenen Punkt, nicht die alte zum Kickoff
    expect(last.input).toContain('Offene Rückfrage: Der Agent hat zum offenen Punkt „Backup prüfen“');
    expect(last.input).not.toContain('AN WELCHEM DATUM');
  });

  it('scheitert schon die Einordnung, bleibt die alte Rückfrage bestehen', async () => {
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    vi.spyOn(app.services.chat as unknown as Internals, 'classify').mockRejectedValue(new Error('Einordnung kaputt'));

    const r2 = await send('Notiz: Server läuft wieder.', r1.conversationId);

    expect(r2.assistantMessage.content).toMatch(/^Das konnte ich nicht verarbeiten: Unerwarteter Fehler/);
    expect(r2.assistantMessage.errorMessage).toContain('Einordnung kaputt');
    expect(notes()).toHaveLength(0);
    vi.restoreAllMocks();
    await send('Hallo', r1.conversationId);
    const last = app.llm.calls.filter((c) => c.schema === 'ChatIntent').at(-1)!;
    expect(last.input).toContain('Offene Rückfrage: Der Agent hat gefragt, AN WELCHEM DATUM das Ereignis „Kickoff mit Kunde“');
  });
});
