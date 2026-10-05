import { z } from 'zod';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const count = z.number().int().nonnegative().optional();
const responsesUsageSchema = z.object({
  usage: z.object({ input_tokens: count, output_tokens: count, input_tokens_details: z.object({ cached_tokens: count }).nullish() }).nullish(),
});
const embeddingsUsageSchema = z.object({ usage: z.object({ prompt_tokens: count, total_tokens: count }).nullish() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Usage of a /responses answer; input excludes cached tokens (same convention as the agent adapters). Null if the answer reports none. */
export function responsesUsage(text: string): TokenUsage | null {
  const usage = responsesUsageSchema.safeParse(parseJson(text)).data?.usage;
  if (!usage) return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached), outputTokens: usage.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** Usage of an /embeddings answer (prompt tokens count as input). Null if the answer reports none. */
export function embeddingsUsage(text: string): TokenUsage | null {
  const usage = embeddingsUsageSchema.safeParse(parseJson(text)).data?.usage;
  if (!usage) return null;
  return { inputTokens: usage.prompt_tokens ?? usage.total_tokens ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** The POSTs of one transmission and the tokens they reported; a retry adds to the same tally. */
export class UsageTally {
  requests = 0;
  private sum: TokenUsage | null = null;
  private notes: string[] = [];

  countRequest(): void {
    this.requests += 1;
  }

  add(usage: TokenUsage | null): void {
    if (!usage) return;
    const current = this.sum ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.sum = {
      inputTokens: current.inputTokens + usage.inputTokens,
      outputTokens: current.outputTokens + usage.outputTokens,
      cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens + usage.cacheWriteTokens,
    };
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  /** Columns of the transmission log: tokens are null when no answer reported any. */
  columns(): {
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    note: string | null;
  } {
    return {
      requests: Math.max(1, this.requests),
      inputTokens: this.sum?.inputTokens ?? null,
      outputTokens: this.sum?.outputTokens ?? null,
      cacheReadTokens: this.sum?.cacheReadTokens ?? null,
      cacheWriteTokens: this.sum?.cacheWriteTokens ?? null,
      note: this.notes.length ? this.notes.join(' ') : null,
    };
  }
}
