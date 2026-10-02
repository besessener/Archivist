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

/** Methods with a graded score that can be made a little stricter; at the cap their strongest proposals still pass. */
const LEARNABLE = {
  similarity: { cap: 0.1, measure: 'Mindest-Ähnlichkeit' },
  date_person: { cap: 0.1, measure: 'Mindest-Konfidenz' },
} as const satisfies Partial<Record<RelationMethod, { cap: number; measure: string }>>;
export type LearnableMethod = keyof typeof LEARNABLE;

interface Decisions {
  confirmed: number;
  rejected: number;
}

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

/** Learning from rejections, gently (#275): a mostly rejected method gets a capped, recomputed raise; none is switched off. */
export class LinkThresholds {
  constructor(
    private readonly ctx: AppContext,
    private readonly appState: AppStateService,
  ) {}

  private decisions(method: LearnableMethod): Decisions {
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
  static raise(decisions: Decisions, cap: number): number {
    const total = decisions.confirmed + decisions.rejected;
    if (total < MIN_DECISIONS) return 0;
    const rate = decisions.rejected / total;
    const level = Math.min(1, Math.max(0, (rate - START_RATE) / (FULL_RATE - START_RATE)));
    return Math.round(cap * level * Math.min(1, total / FULL_WEIGHT) * 1000) / 1000;
  }

  offset(method: LearnableMethod): number {
    return LinkThresholds.raise(this.decisions(method), LEARNABLE[method].cap);
  }

  list(): LearnedThreshold[] {
    return (Object.keys(LEARNABLE) as LearnableMethod[]).map((method) => {
      const decisions = this.decisions(method);
      const { cap, measure } = LEARNABLE[method];
      return { method, label: RELATION_METHOD_LABELS[method], measure, offset: LinkThresholds.raise(decisions, cap), cap, ...decisions };
    });
  }

  /** Forgets what was learned: earlier decisions no longer count (the rejected pairs themselves stay rejected). */
  reset(): void {
    this.appState.set(RESET_AT, new Date().toISOString());
    this.ctx.events.changed('settings', 'knowledge');
  }
}
