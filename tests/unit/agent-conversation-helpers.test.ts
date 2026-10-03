import { describe, expect, it } from 'vitest';
import { ASK_USER } from '../../packages/core/src/agent/ask-user';
import { modeOverrideIn } from '../../packages/core/src/agent/chat-reply';
import { historyWindow, pendingCalls } from '../../packages/core/src/agent/history-window';
import type { AgentMessage, AgentToolCall } from '../../packages/core/src/agent/types';
import { call } from '../helpers/agent-runner';

describe('conversation helpers of the agent service', () => {
  const assistant = (toolCalls: AgentToolCall[], text = ''): AgentMessage => ({ role: 'assistant', text, toolCalls, provider: 'openai', model: 'm' });

  it('pendingCalls: unanswered calls of the last assistant message', () => {
    expect(pendingCalls([])).toEqual([]);
    const h: AgentMessage[] = [{ role: 'user', content: 'x' }, assistant([call('a', {}, 'a1'), call(ASK_USER, { question: '?' }, 'q1')])];
    expect(pendingCalls(h).map((c) => c.id)).toEqual(['a1', 'q1']);
    h.push({ role: 'tool', results: [{ callId: 'a1', name: 'a', content: 'ok', isError: false }] });
    expect(pendingCalls(h).map((c) => c.id)).toEqual(['q1']);
    h.push({ role: 'tool', results: [{ callId: 'q1', name: ASK_USER, content: 'Antwort', isError: false }] }, assistant([], 'fertig'));
    expect(pendingCalls(h)).toEqual([]);
  });

  it('historyWindow: the newest part that fits, always starting with a user message', () => {
    const h: AgentMessage[] = [
      { role: 'user', content: 'a'.repeat(100) },
      assistant([call('x', {}, 'x1')]),
      { role: 'tool', results: [{ callId: 'x1', name: 'x', content: 'b'.repeat(100), isError: false }] },
      assistant([], 'antwort'),
      { role: 'user', content: 'zweite Frage' },
      assistant([], 'zweite Antwort'),
    ];
    expect(historyWindow(h)).toEqual(h);
    const small = historyWindow(h, 300);
    expect(small[0]).toEqual({ role: 'user', content: 'zweite Frage' });
    expect(small).toHaveLength(2);
  });

  it('historyWindow: never starts with tool results, even when the current request alone is larger than the window', () => {
    const h: AgentMessage[] = [
      { role: 'user', content: 'alte Frage' },
      assistant([], 'alte Antwort'),
      { role: 'user', content: 'Räum das Archiv auf' },
      assistant([call('x', {}, 'x1')]),
      { role: 'tool', results: [{ callId: 'x1', name: 'x', content: 'b'.repeat(5_000), isError: false }] },
    ];
    const w = historyWindow(h, 1_000);
    expect(w[0]).toEqual({ role: 'user', content: 'Räum das Archiv auf' });
    expect(w.at(-1)!.role).toBe('tool');
  });

  it('modeOverrideIn: „frag mich diesmal vorher“ and „mach einfach“', () => {
    expect(modeOverrideIn('Frag mich diesmal vorher: räum auf')).toBe('ask');
    expect(modeOverrideIn('bitte nur vorschlagen')).toBe('ask');
    expect(modeOverrideIn('Mach es einfach')).toBe('auto');
    expect(modeOverrideIn('ohne nachzufragen verschieben')).toBe('auto');
    expect(modeOverrideIn('Verschiebe die Datei')).toBeNull();
  });
});
