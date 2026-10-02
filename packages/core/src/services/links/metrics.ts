import { RELATION_METHOD_LABELS, type RelationMethod } from '@archivist/shared';
import { entrySql, LINK_ENTRY_TYPES, OWN_FLOW_TYPES, sqlList, storedList, type LinkDeps } from './entries';

/** How well the archive is linked (#292): one point of the history. */
export interface LinkageSnapshot {
  at: string;
  entries: number;
  orphans: number;
  openProposals: number;
  /** Share of user decisions that confirmed a proposal (all methods), null without decisions. */
  confirmationRate: number | null;
}

export interface LinkageMetrics {
  current: LinkageSnapshot;
  /** Per method of the automatic proposals: decisions of the user and open proposals. */
  methods: Array<{ method: RelationMethod; label: string; confirmed: number; rejected: number; open: number; rate: number | null }>;
  /** One point per archive check, oldest first. */
  history: LinkageSnapshot[];
}

/** The totals a snapshot takes from the orphan and proposal lists. */
export interface LinkageTotals {
  orphans: () => number;
  openProposals: () => number;
}

/** History of the linkage metrics (#292), one point per archive check. */
const METRICS_HISTORY = 'links.metrics.history';
/** Points kept in the history (with a daily check about a year). */
const MAX_METRICS_POINTS = 400;
/** Methods of the automatic proposals whose confirmation rate is measured (#292). */
const MEASURED_METHODS: RelationMethod[] = ['similarity', 'mention', 'co_origin', 'date_person', 'analysis', 'agent', 'refinement'];

const rateOf = (confirmed: number, rejected: number): number | null => (confirmed + rejected ? confirmed / (confirmed + rejected) : null);

/** Linkage metrics (#292): counts only, no texts. */
export class LinkageMetricsLog {
  constructor(
    private readonly deps: LinkDeps,
    private readonly totals: LinkageTotals,
  ) {}

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  /** How well the archive is linked right now, with the history of the archive checks. */
  metrics(): LinkageMetrics {
    const methods = this.methodCounts();
    return { current: this.snapshot(methods), methods, history: this.history() };
  }

  /** Stores the current metrics as one point of the history; called by every archive check. */
  recordMetrics(): LinkageSnapshot {
    const point = this.snapshot(this.methodCounts());
    this.deps.appState.set(METRICS_HISTORY, JSON.stringify([...this.history(), point].slice(-MAX_METRICS_POINTS)));
    return point;
  }

  /** Decisions of the user and open proposals per method of the automatic proposals (from the provenance of #270). */
  private methodCounts(): LinkageMetrics['methods'] {
    const rows = this.sqlite
      .prepare(
        `SELECT r.method AS method,
           sum(CASE WHEN r.status = 'confirmed' AND r.resolved_by_user = 1 THEN 1 ELSE 0 END) AS confirmed,
           sum(CASE WHEN r.status = 'rejected' AND r.resolved_by_user = 1 THEN 1 ELSE 0 END) AS rejected,
           sum(CASE WHEN r.status = 'proposed' THEN 1 ELSE 0 END) AS open
         FROM relations r WHERE r.method IN (${sqlList(MEASURED_METHODS)}) AND (r.relation_type NOT IN (${sqlList(OWN_FLOW_TYPES)}) OR r.method = 'refinement')
         GROUP BY r.method`,
      )
      .all() as Array<{ method: RelationMethod; confirmed: number; rejected: number; open: number }>;
    const byMethod = new Map(rows.map((row) => [row.method, row]));
    return MEASURED_METHODS.map((method) => {
      const { confirmed, rejected, open } = byMethod.get(method) ?? { confirmed: 0, rejected: 0, open: 0 };
      return { method, label: RELATION_METHOD_LABELS[method], confirmed, rejected, open, rate: rateOf(confirmed, rejected) };
    });
  }

  private snapshot(methods: LinkageMetrics['methods']): LinkageSnapshot {
    const entries = (this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${entrySql('e', LINK_ENTRY_TYPES)}`).get() as { c: number }).c;
    const confirmed = methods.reduce((sum, method) => sum + method.confirmed, 0);
    const rejected = methods.reduce((sum, method) => sum + method.rejected, 0);
    return {
      at: new Date().toISOString(),
      entries,
      orphans: this.totals.orphans(),
      openProposals: this.totals.openProposals(),
      confirmationRate: rateOf(confirmed, rejected),
    };
  }

  private history(): LinkageSnapshot[] {
    return storedList(this.deps.appState, METRICS_HISTORY) as LinkageSnapshot[];
  }
}
