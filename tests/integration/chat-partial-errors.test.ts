import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentClassifier } from '../../packages/core/src/services/chat/intent-classifier';
import { PendingQuestions } from '../../packages/core/src/services/chat/pending-questions';
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

const notes = () => app.services.graph.listEntities({ type: 'note' });

describe('Error in the middle of a message: partial results are preserved (#50)', () => {
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

  it('two requests, the second fails: the note stays, the answer names both, the old state is gone', async () => {
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    expect(r1.assistantMessage.content).toMatch(/An welchem Datum war das Ereignis „Kickoff mit Kunde“/);
    vi.spyOn(app.services.openItems, 'create').mockImplementation(() => {
      throw new Error('kaputt');
    });

    const r2 = await send('Notiz: Server läuft wieder. Offen: Backup prüfen', r1.conversationId);

    expect(notes().map((n) => n.name)).toEqual(['Server läuft wieder']);
    expect(await app.ok('openItems:list', {})).toHaveLength(0);
    const reply = r2.assistantMessage;
    // completed and failed parts both appear in the answer – resending is not needed for the note
    expect(reply.content).toContain('Notiz gespeichert');
    expect(reply.content).toContain('Das hat nicht geklappt: offener Punkt: „Offen: Backup prüfen“ – Unerwarteter Fehler.');
    expect(reply.content).not.toContain('Das konnte ich nicht verarbeiten');
    expect(reply.errorMessage).toContain('kaputt');
    expect(reply.intent).toBe('note_capture');
    expect(reply.sources.some((s) => s.type === 'note')).toBe(true);
    // the old follow-up question about the date is not restored
    expect(reply.content).toMatch(/Hinweis: Das Ereignis „Kickoff mit Kunde“ habe ich ohne Datum nicht eingetragen/);
    await send('Hallo', r1.conversationId);
    const last = app.llm.calls.filter((c) => c.schema === 'ChatIntent').at(-1)!;
    expect(last.input).toContain('Offene Rückfrage: keine');
  });

  it('if the only request fails, no half-set follow-up question is left behind', async () => {
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

  it('an error outside the individual requests keeps what was already completed in the answer and state', async () => {
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    // the hint about the discarded follow-up question is produced only after the requests – if it fails, the note is already saved
    vi.spyOn(PendingQuestions.prototype, 'droppedHint').mockImplementation(() => {
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
    // the state matches what was completed: the follow-up question about the open item, not the old one about the kickoff
    expect(last.input).toContain('Offene Rückfrage: Der Agent hat zum offenen Punkt „Backup prüfen“');
    expect(last.input).not.toContain('AN WELCHEM DATUM');
  });

  it('if the classification itself fails, the old follow-up question remains', async () => {
    const r1 = await send('Der Kickoff mit dem Kunden hat stattgefunden.');
    vi.spyOn(IntentClassifier.prototype, 'classify').mockRejectedValue(new Error('Einordnung kaputt'));

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
