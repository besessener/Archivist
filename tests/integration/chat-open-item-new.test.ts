import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveOpenItem } from '../../packages/core/src/services/chat';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });

describe('deriveOpenItem (#41)', () => {
  it.each([
    [
      'Kaffee ist alle. Ich muss noch das Angebot für Müller prüfen, er wollte Rabatt.',
      'Das Angebot für Müller prüfen',
      'das Angebot für Müller prüfen, er wollte Rabatt',
    ],
    ['Offener Punkt: Finanzierungszusage einholen', 'Finanzierungszusage einholen', null],
    ['TODO: Steuererklärung abgeben', 'Steuererklärung abgeben', null],
  ])('%s', (text, title, description) => {
    expect(deriveOpenItem(text)).toEqual({ title, description });
  });
});

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});
const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

describe('Neue offene Punkte vollständig anlegen (#41)', () => {
  it('ohne LLM: kurzer Titel aus dem passenden Abschnitt, Details in der Beschreibung, Quelle ist die Chat-Nachricht', async () => {
    app.llm.down = true;
    const r = await send('Offener Punkt: Ich muss noch das Angebot für Müller prüfen, er wollte Rabatt.');
    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.title).toBe('Das Angebot für Müller prüfen');
    expect(item.description).toContain('er wollte Rabatt');
    const userMsg = (await app.ok('chat:history', { conversationId: r.conversationId }))[0]!;
    expect(item.sourceIds).toEqual([userMsg.id]);
    expect(item.sourceConversationId).toBe(r.conversationId);
  });

  it('mit LLM: ein „Titel“, der die ganze Nachricht ist, wird gekürzt; „ich“ wird zum Benutzer (nie zur Person „ich“)', async () => {
    app.services.settings.update({ profile: { name: 'Max Mustermann', nicknames: [] } });
    const text = 'Ich muss noch das Angebot für Müller prüfen, er wollte Rabatt.';
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', segment: text, openItem: { title: text, responsible: 'ich' } }));
    const r = await send(text);
    const item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.title).toBe('Das Angebot für Müller prüfen');
    expect(item.responsibleName).toBe('Max Mustermann');
    expect(app.services.graph.findByName('person', 'ich')).toBeFalsy();
    expect(r.assistantMessage.content).not.toMatch(/Wer ist verantwortlich/);
  });

  it('ohne hinterlegten Namen bleibt „ich“ leer und der Chat sagt, wie man das ändert', async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Zahnarzt anrufen', responsible: 'mir' } }));
    const r = await send('Zahnarzt anrufen bleibt an mir hängen');
    expect((await app.ok('openItems:list', {}))[0]!.responsibleName).toBeNull();
    expect(r.assistantMessage.content).toContain('Einstellungen → Über Sie');
    expect(app.services.graph.findByName('person', 'mir')).toBeFalsy();
  });

  it('Dublettenprüfung: fragt „ergänzen oder neu anlegen?“; „Ergänzen“ hängt die Details an', async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Angebot Müller prüfen', description: 'er wollte Rabatt' } }));
    const r1 = await send('Angebot Müller prüfen, er wollte Rabatt');
    expect(await app.ok('openItems:list', {})).toHaveLength(1);

    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Angebot Müller prüfen', description: 'bis Freitag Rückmeldung' } }));
    const r2 = await send('Angebot Müller prüfen, bis Freitag Rückmeldung', r1.conversationId);
    expect(r2.assistantMessage.content).toBe('Gibt es schon: ‚Angebot Müller prüfen‘ – ergänzen oder neu anlegen?');
    expect(r2.assistantMessage.quickReplies).toEqual(['Ergänzen', 'Neu anlegen']);
    expect(await app.ok('openItems:list', {})).toHaveLength(1);

    await send('Ergänzen', r1.conversationId);
    const items = await app.ok('openItems:list', {});
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe('er wollte Rabatt\nbis Freitag Rückmeldung');
  });

  it('„Neu anlegen“ legt trotz ähnlichem Punkt einen neuen an', async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_new', openItem: { title: 'Angebot Müller prüfen' } }));
    const r1 = await send('Angebot Müller prüfen');
    await send('Angebot Müller prüfen', r1.conversationId);
    await send('Neu anlegen', r1.conversationId);
    expect(await app.ok('openItems:list', {})).toHaveLength(2);
  });

  it('Ergänzungen per Chat hängen an die Beschreibung an', async () => {
    const item = await app.ok('openItems:create', { title: 'Budget planen', description: 'für 2027', priority: 'normal', sourceIds: [], confidence: 0.9 });
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_update', openItem: { targetHint: 'Budget', description: 'inklusive Reisekosten' } }));
    await send('Beim Budget bitte auch die Reisekosten einplanen');
    expect((await app.ok('openItems:list', {})).find((i) => i.id === item.id)!.description).toBe('für 2027\ninklusive Reisekosten');
  });
});
