import { RELATION_METHOD_LABELS, type RelationMethod } from '@archivist/shared';
import type { AppContext } from '../context';
import type { AppStateService } from './app-state';

/** When the learned thresholds were last reset (#275); only decisions after it count. */
const RESET_AT = 'links.thresholds.resetAt';
/** The most recent user decisions per method that are taken into account. */
const WINDOW = 40;
/** Below this many decisions nothing is learned. */
const MIN_DECISIONS = 8;
/** Rejection rate from which the threshold starts to rise; at {@link FULL_RATE} it reaches the cap. */
const START_RATE = 0.5;
const FULL_RATE = 0.9;
/** Decisions from which a rate counts fully (fewer: the rise is scaled down). */
const FULL_WEIGHT = 20;

/**
 * Methods whose proposals carry a graded score and can therefore be made a little stricter. The cap keeps every method
 * alive: even at the cap the strongest proposals of the method still pass (a cosine up to 1; two shared persons on the same day).
 */
const LEARNABLE = {
  similarity: { cap: 0.1, measure: 'Mindest-Ähnlichkeit' },
  date_person: { cap: 0.1, measure: 'Mindest-Konfidenz' },
} as const satisfies Partial<Record<RelationMethod, { cap: number; measure: string }>>;
export type LearnableMethod = keyof typeof LEARNABLE;

export interface LearnedThreshold {
  method: LearnableMethod;
  label: string;
  measure: string;
  /** Raise of the threshold (0 … cap), added to the method's own threshold. */
  offset: number;
  cap: number;
  /** Decisions of the user in the window since the last reset. */
  confirmed: number;
  rejected: number;
}

/**
 * Learning from rejections, gently (#275): rejected pairs never come back anyway (#270). Beyond that, a method most of
 * whose recent proposals the user rejected becomes a little stricter – the raise grows with the rejection rate, is capped
 * and shrinks again with confirmations (it is computed from the latest decisions, nothing accumulates). No method is ever
 * switched off. Reset in the settings: only decisions after the reset count.
 */
export class LinkThresholds {
  constructor(
    private readonly ctx: AppContext,
    private readonly appState: AppStateService,
  ) {}

  private decisions(method: LearnableMethod): { confirmed: number; rejected: number } {
    const since = this.appState.get(RESET_AT) ?? '';
    const rows = this.ctx.database.sqlite
      .prepare(
        `SELECT status FROM relations WHERE method = ? AND resolved_by_user = 1 AND status IN ('confirmed','rejected') AND updated_at > ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(method, since, WINDOW) as Array<{ status: string }>;
    const rejected = rows.filter((r) => r.status === 'rejected').length;
    return { confirmed: rows.length - rejected, rejected };
  }

  /** The raise for one method from its latest decisions: 0 below the start rate, the cap from the full rate on. */
  static raise(confirmed: number, rejected: number, cap: number): number {
    const n = confirmed + rejected;
    if (n < MIN_DECISIONS) return 0;
    const rate = rejected / n;
    const level = Math.min(1, Math.max(0, (rate - START_RATE) / (FULL_RATE - START_RATE)));
    return Math.round(cap * level * Math.min(1, n / FULL_WEIGHT) * 1000) / 1000;
  }

  offset(method: LearnableMethod): number {
    const d = this.decisions(method);
    return LinkThresholds.raise(d.confirmed, d.rejected, LEARNABLE[method].cap);
  }

  list(): LearnedThreshold[] {
    return (Object.keys(LEARNABLE) as LearnableMethod[]).map((method) => {
      const d = this.decisions(method);
      const { cap, measure } = LEARNABLE[method];
      return { method, label: RELATION_METHOD_LABELS[method], measure, offset: LinkThresholds.raise(d.confirmed, d.rejected, cap), cap, ...d };
    });
  }

  /** Forgets what was learned: earlier decisions no longer count (the rejected pairs themselves stay rejected). */
  reset(): void {
    this.appState.set(RESET_AT, new Date().toISOString());
    this.ctx.events.changed('settings', 'knowledge');
  }
}
