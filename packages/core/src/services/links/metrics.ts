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

type OpenByMethod = Array<{ key: string; count: number }>;

/** The totals a snapshot takes from the orphan and proposal lists. */
export interface LinkageTotals {
  orphans: () => number;
  /** The open proposals per method, as the proposal list groups and counts them. */
  openByMethod: () => OpenByMethod;
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
    const { methods, current } = this.measure();
    return { current, methods, history: this.history() };
  }

  /** Stores the current metrics as one point of the history; called by every archive check. */
  recordMetrics(): LinkageSnapshot {
    const point = this.measure().current;
    this.deps.appState.set(METRICS_HISTORY, JSON.stringify([...this.history(), point].slice(-MAX_METRICS_POINTS)));
    return point;
  }

  private measure(): Pick<LinkageMetrics, 'methods' | 'current'> {
    const open = this.totals.openByMethod();
    const methods = this.methodCounts(open);
    return { methods, current: this.snapshot({ methods, open }) };
  }

  /** Decisions of the user (from the provenance of #270) and open proposals – those the list shows – per method of the automatic proposals. */
  private methodCounts(openByMethod: OpenByMethod): LinkageMetrics['methods'] {
    const rows = this.sqlite
      .prepare(
        `SELECT r.method AS method,
           sum(CASE WHEN r.status = 'confirmed' AND r.resolved_by_user = 1 THEN 1 ELSE 0 END) AS confirmed,
           sum(CASE WHEN r.status = 'rejected' AND r.resolved_by_user = 1 THEN 1 ELSE 0 END) AS rejected
         FROM relations r WHERE r.method IN (${sqlList(MEASURED_METHODS)}) AND (r.relation_type NOT IN (${sqlList(OWN_FLOW_TYPES)}) OR r.method = 'refinement')
         GROUP BY r.method`,
      )
      .all() as Array<{ method: RelationMethod; confirmed: number; rejected: number }>;
    const decided = new Map(rows.map((row) => [row.method, row]));
    const open = new Map(openByMethod.map((group) => [group.key, group.count]));
    return MEASURED_METHODS.map((method) => {
      const { confirmed, rejected } = decided.get(method) ?? { confirmed: 0, rejected: 0 };
      return { method, label: RELATION_METHOD_LABELS[method], confirmed, rejected, open: open.get(method) ?? 0, rate: rateOf(confirmed, rejected) };
    });
  }

  private snapshot({ methods, open }: { methods: LinkageMetrics['methods']; open: OpenByMethod }): LinkageSnapshot {
    const entries = (this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${entrySql('e', LINK_ENTRY_TYPES)}`).get() as { c: number }).c;
    const confirmed = methods.reduce((sum, method) => sum + method.confirmed, 0);
    const rejected = methods.reduce((sum, method) => sum + method.rejected, 0);
    return {
      at: new Date().toISOString(),
      entries,
      orphans: this.totals.orphans(),
      openProposals: open.reduce((sum, group) => sum + group.count, 0),
      confirmationRate: rateOf(confirmed, rejected),
    };
  }

  private history(): LinkageSnapshot[] {
    return storedList(this.deps.appState, METRICS_HISTORY) as LinkageSnapshot[];
  }
}
