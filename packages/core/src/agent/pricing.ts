import type { AgentUsage, ModelPrice } from '@archivist/shared';

/** Built-in prices in US$ per 1M tokens (as of 2026-10), shown for information only (#302); own prices take precedence. */
const PRICES: Array<[prefix: string, price: ModelPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  // Opus 4 (claude-opus-4-20250514) and 4.1 kept the old Opus price
  ['claude-opus-4-1', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-opus-4-20250514', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-haiku-4', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ['gpt-5.6-sol', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }],
  ['gpt-5.6-terra', { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }],
  ['gpt-5.6-luna', { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 }],
  ['gpt-5.5', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }],
  ['gpt-5.4-mini', { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 }],
  ['gpt-5.4-nano', { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 }],
  ['gpt-5.4', { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
  ['gpt-5.2', { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }],
  ['gpt-5.1', { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
  ['gpt-5-mini', { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 }],
  ['gpt-5-nano', { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 }],
  ['gpt-5', { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
  ['gpt-4.1-mini', { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 }],
  ['gpt-4.1-nano', { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 }],
  ['gpt-4.1', { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 }],
  ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 }],
  ['o4-mini', { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 }],
];

/** The prefix names the model itself, not an older version of it: `gpt-5` must not price `gpt-5.5`. */
function matches(name: string, prefix: string): boolean {
  const at = name.indexOf(prefix);
  return at !== -1 && !/^[.\d]/.test(name.slice(at + prefix.length));
}

/** Matched by prefix of the lower-cased model or deployment name; an unknown version has no price rather than a wrong one. */
export function priceFor(model: string, own: Record<string, ModelPrice> = {}): ModelPrice | null {
  if (own[model]) return own[model];
  const name = model.toLowerCase().replace(/^(?:anthropic\.|openai\/)/, '');
  // longest matching prefix wins (claude-opus-5-5 before claude-opus-5)
  const hit = PRICES.filter(([prefix]) => matches(name, prefix)).toSorted((a, b) => b[0].length - a[0].length)[0];
  return hit?.[1] ?? null;
}

/** Estimated cost of a usage in US$; null without a price. Uncached input = input tokens as reported. */
export function costOf(
  usage: Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
  price: ModelPrice | null,
): number | null {
  if (!price) return null;
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/** Tokens that count against the technical budget of a run: cache reads count a tenth (they cost a tenth). */
export function budgetTokens(usage: Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + Math.round(usage.cacheReadTokens / 10);
}

export const emptyUsage = (): AgentUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, retries: 0 });

export function addUsage(a: AgentUsage, b: Partial<AgentUsage>): AgentUsage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
    requests: a.requests + (b.requests ?? 0),
    retries: a.retries + (b.retries ?? 0),
  };
}
