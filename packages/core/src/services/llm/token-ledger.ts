import type { LlmUsage, ModelPrice, TokenTotals } from '@archivist/shared';
import { gte, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { llmTransmissions } from '../../db/schema';
import { TokenCapError, tokenCapOverride } from '../../util/token-cap';
import { costOf, priceFor } from '../../agent/pricing';

/** Start of the local day / month containing `now`, as an ISO timestamp (the log stores UTC). */
export const startOfDay = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
export const startOfMonth = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
/** Start of the next local day (epoch ms): when a paused job may run again. */
export const startOfNextDay = (now: Date): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

/** Tokens of one model in the log. */
interface ModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

/** Totals over all models; the cost counts what each model's price covers (own prices first), the rest as unpriced tokens. */
export function tokenTotals(rows: ModelTokens[], prices: Record<string, ModelPrice>): TokenTotals {
  const totals: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requests: 0,
    costUsd: null,
    unpricedTokens: 0,
  };
  for (const row of rows) {
    const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    totals.totalTokens += tokens;
    totals.requests += row.requests;
    const cost = costOf(row, priceFor(row.model, prices));
    if (cost === null) totals.unpricedTokens += tokens;
    else totals.costUsd = (totals.costUsd ?? 0) + cost;
  }
  return totals;
}

/** Tokens used so far, summed from the transmission log, and the optional daily limit. */
export class TokenLedger {
  constructor(
    private readonly ctx: AppContext,
    private readonly limits: { dailyCap: () => number | null; prices: () => Record<string, ModelPrice> },
  ) {}

  private dailyCap(): number | null {
    return this.limits.dailyCap();
  }

  private totalsSince(since: string): TokenTotals {
    const t = llmTransmissions;
    const rows = this.ctx.database.db
      .select({
        model: t.model,
        inputTokens: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${t.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${t.cacheWriteTokens}), 0)`,
        requests: sql<number>`coalesce(sum(${t.requests}), 0)`,
      })
      .from(t)
      .where(gte(t.at, since))
      .groupBy(t.model)
      .all();
    return tokenTotals(rows, this.limits.prices());
  }

  /** Whether today's tokens have reached the limit; false without a limit (then the database is not even asked). */
  capReached(now = new Date()): boolean {
    const cap = this.dailyCap();
    return cap !== null && this.totalsSince(startOfDay(now)).totalTokens >= cap;
  }

  /** Throws `TokenCapError` once the limit is reached, unless the user chose to continue for this request. */
  assertWithinCap(): void {
    const cap = this.dailyCap();
    if (cap === null || tokenCapOverride.getStore() || !this.capReached()) return;
    throw new TokenCapError(cap);
  }

  summary(now = new Date()): LlmUsage {
    const cap = this.dailyCap();
    const today = this.totalsSince(startOfDay(now));
    return { today, month: this.totalsSince(startOfMonth(now)), dailyCap: cap, capReached: cap !== null && today.totalTokens >= cap };
  }
}
