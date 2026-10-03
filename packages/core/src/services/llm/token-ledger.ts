import type { LlmUsage, TokenTotals } from '@archivist/shared';
import { gte, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { llmTransmissions } from '../../db/schema';
import { TokenCapError, tokenCapOverride } from '../../util/token-cap';

/** Start of the local day / month containing `now`, as an ISO timestamp (the log stores UTC). */
export const startOfDay = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
export const startOfMonth = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
/** Start of the next local day (epoch ms): when a paused job may run again. */
export const startOfNextDay = (now: Date): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

/** Tokens used so far, summed from the transmission log, and the optional daily limit. */
export class TokenLedger {
  constructor(
    private readonly ctx: AppContext,
    private readonly dailyCap: () => number | null,
  ) {}

  private totalsSince(since: string): TokenTotals {
    const t = llmTransmissions;
    const row = this.ctx.database.db
      .select({
        input: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
        output: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
        cache: sql<number>`coalesce(sum(${t.cacheReadTokens}), 0)`,
        requests: sql<number>`coalesce(sum(${t.requests}), 0)`,
      })
      .from(t)
      .where(gte(t.at, since))
      .get();
    const [inputTokens, outputTokens, cacheReadTokens, requests] = [row?.input ?? 0, row?.output ?? 0, row?.cache ?? 0, row?.requests ?? 0];
    return { inputTokens, outputTokens, cacheReadTokens, requests, totalTokens: inputTokens + outputTokens + cacheReadTokens };
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
