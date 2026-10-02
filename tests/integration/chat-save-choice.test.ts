import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSaveChoice } from '../../packages/core/src/services/chat';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const decisionEx = (over: Record<string, unknown> = {}) => ({ participants: [], alternatives: [], unknownFields: [], confidence: 0.85, ...over });

describe('parseSaveChoice (#43)', () => {
  it.each([
    ['Nein, als Notiz', 'note'],
    ['Keine Entscheidung, sondern ein Ereignis', 'event'],
    ['Nur als Notiz', 'note'],
    ['Ja, als Notiz', 'note'],
    ['bitte als Entscheidung', 'decision'],
    ['nur als Ereignis', 'event'],
    ['Entscheidung', 'decision'],
    ['lieber als Termin', 'event'],
    ['keine Entscheidung, nur merken', 'note'],
    ['nicht als Entscheidung', null],
    ['nichts speichern', 'nothing'],
    ['nein', 'nothing'],
    ['lieber nicht', 'nothing'],
    ['ja', null],
    ['Entscheidung oder Notiz?', null],
    ['Wie viele Dokumente gibt es?', null],
  ])('%s → %s', (text, expected) => {
    expect(parseSaveChoice(text)).toBe(expected);
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
const unsure = () => ({
  intents: [
    intent({
      intent: 'decision_new',
      segment: 'Kickoff mit dem Kunden am 03.03.2026',
      decisionCertainty: 'unsure',
      decision: decisionEx({ decisionText: 'Kickoff mit dem Kunden', title: 'Kickoff mit Kunde', decidedAt: '2026-03-03' }),
    }),
  ],
});

describe('Answers to „Entscheidung, Ereignis, Notiz oder nichts?“ (#43)', () => {
  it('the follow-up question has buttons', async () => {
    app.llm.on('ChatIntent', unsure);
    const r = await send('Kickoff mit dem Kunden am 03.03.2026');
    expect(r.assistantMessage.quickReplies).toEqual(['Entscheidung', 'Ereignis', 'Notiz', 'Nichts speichern']);
    const history = await app.ok('chat:history', { conversationId: r.conversationId });
    expect(history.at(-1)!.quickReplies).toEqual(['Entscheidung', 'Ereignis', 'Notiz', 'Nichts speichern']);
  });

  it('„Nein, als Notiz“ creates a note (instead of saving nothing)', async () => {
    app.llm.on('ChatIntent', unsure);
    const r1 = await send('Kickoff mit dem Kunden am 03.03.2026');
    app.llm.on('ChatIntent', () => intent({ intent: 'proposal_reject' }));
    const r2 = await send('Nein, als Notiz', r1.conversationId);
    expect(r2.assistantMessage.content).toMatch(/^Notiz gespeichert/);
    expect((await app.ok('search:global', { query: 'Kickoff Kunden', limit: 5 })).some((h) => h.type === 'note')).toBe(true);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
  });

  it('„Keine Entscheidung, sondern ein Ereignis“ records an event', async () => {
    app.llm.on('ChatIntent', unsure);
    const r1 = await send('Kickoff mit dem Kunden am 03.03.2026');
    const r2 = await send('Keine Entscheidung, sondern ein Ereignis', r1.conversationId);
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect((await app.ok('events:list', {}))[0]).toMatchObject({ title: 'Kickoff mit Kunde' });
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
  });

  it('not recognized, without an LLM: asks again with buttons and forgets nothing', async () => {
    app.llm.on('ChatIntent', unsure);
    const r1 = await send('Kickoff mit dem Kunden am 03.03.2026');
    app.llm.down = true;
    const r2 = await send('ja', r1.conversationId);
    expect(r2.assistantMessage.content).toContain('Das habe ich nicht verstanden');
    expect(r2.assistantMessage.quickReplies).toContain('Ereignis');
    const r3 = await send('Ereignis', r1.conversationId);
    expect(r3.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
  });

  it('not recognized, with LLM: the LLM classifies the answer with the hint about the follow-up question', async () => {
    app.llm.on('ChatIntent', unsure);
    const r1 = await send('Kickoff mit dem Kunden am 03.03.2026');
    app.llm.on('ChatIntent', (_s, input) => {
      expect(input).toContain('als Entscheidung, als Ereignis, als Notiz oder gar nicht gespeichert werden soll');
      return { intents: [intent({ intent: 'note_capture', note: 'trag das bitte in den Kalender der Vergangenheit ein' })], saveAs: 'event' };
    });
    const r2 = await send('trag das bitte in den Kalender der Vergangenheit ein', r1.conversationId);
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(r2.assistantMessage.content).not.toMatch(/Notiz gespeichert/);
    expect(await app.ok('events:list', {})).toHaveLength(1);
  });
});
