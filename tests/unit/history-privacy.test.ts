import { describe, expect, it } from 'vitest';
import { WITHHELD_RESULT, WITHHELD_TEXT, withholdWithdrawn } from '../../packages/core/src/agent/history-privacy';
import type { AgentMessage, AgentToolCall } from '../../packages/core/src/agent/types';

const user = (content: string): AgentMessage => ({ role: 'user', content });
const assistant = (text: string, toolCalls: AgentToolCall[] = []): AgentMessage => ({
  role: 'assistant',
  text,
  toolCalls,
  provider: 'openai',
  model: 'gpt-test',
  raw: { blocks: text },
});
const toolResults = (...contents: string[]): AgentMessage => ({
  role: 'tool',
  results: contents.map((content, index) => ({ callId: `c${index}`, name: 'find_documents', content, isError: false })),
});
const findCall: AgentToolCall = { id: 'c0', name: 'find_documents', args: {} };

describe('replaying history without withdrawn documents (#202, #301)', () => {
  it('returns the history unchanged, provider blocks included, when nothing was withdrawn', () => {
    const history = [user('Hallo'), assistant('D1 gefunden', [findCall]), toolResults('D1: Rechnung'), assistant('Fertig')];

    const replay = withholdWithdrawn(history, new Set());

    expect(replay).toEqual(history);
    expect(replay).not.toBe(history);
  });

  it('replaces only the tool results that name a withdrawn document', () => {
    const results = toolResults('D7: Steuerbescheid', 'D8: Rechnung', 'D70: Vertrag');

    const [replayed] = withholdWithdrawn([results], new Set(['D7']));

    expect(replayed).toEqual({
      role: 'tool',
      results: [
        {
          callId: 'c0',
          name: 'find_documents',
          content: 'Ergebnis ausgeblendet: Es nannte Dokumente, die inzwischen nicht mehr für die Übertragung freigegeben sind.',
          isError: false,
        },
        { callId: 'c1', name: 'find_documents', content: 'D8: Rechnung', isError: false },
        { callId: 'c2', name: 'find_documents', content: 'D70: Vertrag', isError: false },
      ],
    });
  });

  it('withholds an answer built on a withheld result even when it names no document, up to the next question (#202)', () => {
    const history = [
      user('Was steht im Tagebuch?'),
      assistant('', [findCall]),
      toolResults('D7: Tagebuch'),
      assistant('Du hast von GEHEIMNIS-0815 geschrieben.'),
      user('Danke'),
      assistant('Gern.'),
    ];

    const replay = withholdWithdrawn(history, new Set(['D7']));

    expect(replay.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['', WITHHELD_TEXT, 'Gern.']);
  });

  it('recognises document references with up to five digits', () => {
    const [replayed] = withholdWithdrawn([toolResults('D12: Mietvertrag', 'D12345: Police')], new Set(['D12', 'D12345']));

    expect(replayed).toMatchObject({ results: [{ content: WITHHELD_RESULT }, { content: WITHHELD_RESULT }] });
  });

  it('keeps tool messages that name no withdrawn document as they are', () => {
    const results = toolResults('D8: Rechnung', 'XD7 ist kein Verweis', 'D123456 ist zu lang');

    expect(withholdWithdrawn([results], new Set(['D7', 'D12345']))[0]).toBe(results);
  });

  it('hides answers naming a withdrawn document and leaves user messages alone', () => {
    const history = [user('Was steht in D7?'), assistant('D7 ist ein Steuerbescheid.'), assistant('D8 ist eine Rechnung.')];

    const replay = withholdWithdrawn(history, new Set(['D7']));

    expect(replay[0]).toBe(history[0]);
    expect(replay[1]).toMatchObject({ role: 'assistant', text: '[Antwort ausgeblendet: Sie nannte Dokumente, die inzwischen nicht mehr freigegeben sind.]' });
    expect(replay[2]).toMatchObject({ role: 'assistant', text: 'D8 ist eine Rechnung.' });
  });

  it('drops the provider blocks of all answers except the newest one with open tool calls', () => {
    const history = [assistant('Suche', [findCall]), toolResults('D7: Steuerbescheid'), assistant('Weiter', [findCall])];

    const replay = withholdWithdrawn(history, new Set(['D7']));

    expect(replay[0]).toEqual({ ...history[0], raw: undefined });
    expect(replay[2]).toEqual(history[2]);
  });

  it('keeps the provider blocks of the newest answer when tool results follow it', () => {
    const history = [assistant('Suche', [findCall]), toolResults('D8: Rechnung')];

    expect(withholdWithdrawn(history, new Set(['D7']))[0]).toEqual(history[0]);
  });

  it('also drops the provider blocks of the newest answer when it has no tool calls', () => {
    const history = [assistant('Suche', [findCall]), assistant('D7 war das.')];

    const replay = withholdWithdrawn(history, new Set(['D7']));

    expect(replay[1]).toEqual({ ...history[1], text: WITHHELD_TEXT, raw: undefined });
  });
});
