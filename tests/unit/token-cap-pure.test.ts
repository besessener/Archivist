import { describe, expect, it } from 'vitest';
import { CONTINUE_ANYWAY, dayKey, tokenCapGate } from '../../packages/core/src/services/chat/token-cap-gate';
import { startOfDay, startOfMonth, startOfNextDay } from '../../packages/core/src/services/llm/token-ledger';
import { estimateTokens } from '../../packages/core/src/util/estimate-tokens';

describe('estimateTokens', () => {
  it.each([
    ['', 0],
    ['abc', 1],
    ['abcd', 1],
    ['abcde', 2],
    ['x'.repeat(4000), 1000],
  ])('estimates a text of %j at %s tokens', (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });

  it('takes a number of characters as well, for estimates before a file is read', () => {
    expect(estimateTokens(24_000)).toBe(6000);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-5)).toBe(0);
  });
});

describe('local days for the token limit', () => {
  const now = new Date(2026, 9, 3, 15, 30);

  it('finds the start of the day, of the month and of the next day in local time', () => {
    expect(startOfDay(now)).toBe(new Date(2026, 9, 3).toISOString());
    expect(startOfMonth(now)).toBe(new Date(2026, 9, 1).toISOString());
    expect(startOfNextDay(now)).toBe(new Date(2026, 9, 4).getTime());
    expect(startOfNextDay(new Date(2026, 11, 31, 23, 59))).toBe(new Date(2027, 0, 1).getTime());
  });

  it('names a day by its local date', () => {
    expect(dayKey(now)).toBe('2026-10-03');
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('token limit gate of the chat', () => {
  const base = { cap: 1000, today: '2026-10-03' };

  it('lets everything through while the limit is not reached', () => {
    expect(tokenCapGate({ ...base, text: 'Hallo', state: {}, reached: false })).toEqual({ kind: 'proceed', text: 'Hallo', state: {}, override: false });
  });

  it('asks first and remembers the held message', () => {
    const gate = tokenCapGate({ ...base, text: 'Hallo', state: { last: { topic: 'x' } }, reached: true });

    expect(gate).toMatchObject({
      kind: 'ask',
      reply: { intent: 'token_cap', quickReplies: [CONTINUE_ANYWAY], state: { last: { topic: 'x' }, tokenCap: { awaiting: 'Hallo' } } },
    });
  });

  it('runs the held message when the user continues, and lets the rest of the day through', () => {
    const state = { tokenCap: { awaiting: 'Hallo' } };

    const continued = tokenCapGate({ ...base, text: ` ${CONTINUE_ANYWAY} `, state, reached: true });
    expect(continued).toEqual({ kind: 'proceed', text: 'Hallo', state: { tokenCap: { overrideDay: '2026-10-03' } }, override: true });

    const later = tokenCapGate({ ...base, text: 'Noch etwas', state: { tokenCap: { overrideDay: '2026-10-03' } }, reached: true });
    expect(later).toMatchObject({ kind: 'proceed', text: 'Noch etwas', override: true });
  });

  it('asks again on the next day, and does not treat the answer as a continue without a held message', () => {
    expect(tokenCapGate({ ...base, text: 'Hallo', state: { tokenCap: { overrideDay: '2026-10-02' } }, reached: true }).kind).toBe('ask');
    expect(tokenCapGate({ ...base, text: CONTINUE_ANYWAY, state: {}, reached: true }).kind).toBe('ask');
  });
});
