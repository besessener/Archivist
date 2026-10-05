import { describe, expect, it } from 'vitest';
import { turnUsage } from '../../packages/core/src/agent/adapters/anthropic';
import { costOf, priceFor } from '../../packages/core/src/agent/pricing';
import { tokenTotals } from '../../packages/core/src/services/llm/token-ledger';

describe('model prices', () => {
  it.each([
    ['claude-fable-5-1', { input: 10, cacheRead: 0.25 }],
    ['claude-mythos-5-1', { input: 10, cacheRead: 0.25 }],
    ['claude-fable-5', { input: 10, cacheRead: 1 }],
    ['claude-opus-5-5', { input: 4, cacheRead: 0.2 }],
    ['claude-opus-4-8', { input: 5, cacheRead: 0.5 }],
    ['claude-opus-4-1-20250805', { input: 15, cacheRead: 1.5 }],
    ['claude-opus-4-20250514', { input: 15, cacheRead: 1.5 }],
    ['anthropic.claude-sonnet-5-5', { input: 2, cacheRead: 0.2 }],
    ['gpt-5', { input: 1.25, cacheRead: 0.125 }],
    ['gpt-5-2025-08-07', { input: 1.25, cacheRead: 0.125 }],
    ['gpt-5.2', { input: 1.75, cacheRead: 0.175 }],
    ['gpt-5.4-mini', { input: 0.75, cacheRead: 0.075 }],
    ['gpt-5.5', { input: 5, cacheRead: 0.5 }],
    ['gpt-4o-mini', { input: 0.15, cacheRead: 0.075 }],
  ])('%s', (model, price) => {
    expect(priceFor(model)).toMatchObject(price);
  });

  it('an unknown version gets no price instead of the price of an older one', () => {
    expect(priceFor('gpt-5.3-codex')).toBeNull();
    expect(priceFor('mein-deployment')).toBeNull();
  });

  it('own prices win over the built-in table', () => {
    expect(priceFor('gpt-5.5', { 'gpt-5.5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('a cache read on Fable 5.1 costs a fortieth of fresh input', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 4_000_000, cacheWriteTokens: 0 };
    expect(costOf(usage, priceFor('claude-fable-5-1'))).toBe(1);
  });
});

describe('Claude turn usage', () => {
  const base = { input_tokens: 23_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it('adds a server-side compaction, which the top-level counts leave out', () => {
    const iterations = [
      { type: 'compaction', input_tokens: 180_000, output_tokens: 3_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
      { type: 'message', input_tokens: 23_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
    ];
    expect(turnUsage({ ...base, iterations } as never)).toEqual({ inputTokens: 203_000, outputTokens: 4_500, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('takes the top-level counts as they are without a compaction', () => {
    expect(turnUsage({ ...base, cache_read_input_tokens: 50_000, iterations: null } as never)).toEqual({
      inputTokens: 23_000,
      outputTokens: 1_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
    });
  });
});

describe('daily totals', () => {
  it('prices each model on its own and keeps tokens without a price apart', () => {
    const rows = [
      { model: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, requests: 3 },
      { model: 'unbekannt', inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
    ];
    expect(tokenTotals(rows, {})).toEqual({
      inputTokens: 1_000_500,
      outputTokens: 100,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      totalTokens: 2_000_600,
      requests: 4,
      costUsd: 4.2,
      unpricedTokens: 600,
    });
    expect(tokenTotals([], {})).toMatchObject({ costUsd: null, totalTokens: 0 });
  });
});
