import type { Contradiction, Decision } from '@archivist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { contradictions } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { truncate } from '../util/text';
import type { ActionService } from './actions';
import { announce, proposeSupersede, type ContradictionRow } from './contradiction-notices';
import { ContradictionReviewer, MAX_REVIEWS_PER_CHECK, MAX_REVIEWS_PER_SCAN, type ReviewBudget } from './contradiction-review';
import { compareLexically, relatedPairs, sharesScope } from './contradiction-rules';
import type { DecisionService } from './decisions';
import { ACTIVE_DECISION_STATUSES } from './decisions';
import { orderDecisions } from './decision-dating';
import type { DocumentService } from './documents';
import type { InsightService } from './insights';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { LlmService } from './llm';
import type { NotificationService } from './notifications';
import type { PrivacyService } from './privacy';

/** Why two decisions contradict each other and how sure that is. */
interface Finding {
  reason: string;
  confidence: number;
}

const map = (r: ContradictionRow): Contradiction => ({
  id: r.id,
  title: r.title,
  description: r.description,
  affectedEntityIds: r.affectedEntityIds,
  excerpts: r.excerpts as Contradiction['excerpts'],
  sourceIds: r.sourceIds,
  timestamps: r.timestamps,
  confidence: r.confidence,
  status: r.status as Contradiction['status'],
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

export interface ContradictionServiceDeps {
  ctx: AppContext;
  decisions: DecisionService;
  graph: KnowledgeGraphService;
  insights: InsightService;
  notifications: NotificationService;
  llm: LlmService;
  privacy: PrivacyService;
  docs: Pick<DocumentService, 'findRow'>;
}

/** Job type of the contradiction scan the chat starts (#254). */
export const CONTRADICTION_SCAN_JOB = 'contradiction.scan';

/** Contradictions are hints: decisions are never revoked or superseded autonomously, the resolution is an action the user confirms. */
export class ContradictionService {
  private actions!: ActionService;
  private readonly reviewer: ContradictionReviewer;

  constructor(private readonly deps: ContradictionServiceDeps) {
    this.reviewer = new ContradictionReviewer(deps);
    this.deps.decisions.onStatusUndone((decisionIds) => this.reopenAfterUndo(decisionIds));
    // rejecting the insight closes the contradiction notice as well (seen, both decisions stay)
    this.deps.insights.onRejected((key) => {
      if (!key.startsWith('contradiction:')) return;
      const c = this.db
        .select()
        .from(contradictions)
        .where(eq(contradictions.id, key.slice('contradiction:'.length)))
        .get();
      if (c?.status !== 'detected') return;
      this.db.update(contradictions).set({ status: 'acknowledged' }).where(eq(contradictions.id, c.id)).run();
      this.deps.notifications.resolveByDedupePrefix(`contradiction:${c.id}`);
      this.deps.ctx.events.changed('contradictions');
    });
  }

  wire(deps: { actions: ActionService }): void {
    this.actions = deps.actions;
  }

  private get db() {
    return this.deps.ctx.database.db;
  }

  list(status?: Contradiction['status']): Contradiction[] {
    return this.db
      .select()
      .from(contradictions)
      .where(status ? eq(contradictions.status, status) : undefined)
      .orderBy(desc(contradictions.createdAt))
      .all()
      .map(map);
  }

  get(id: string): Contradiction {
    const r = this.db.select().from(contradictions).where(eq(contradictions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Widerspruch nicht gefunden.');
    return map(r);
  }

  private static pairKey(a: string, b: string): string {
    return `decision:${[a, b].sort().join('|')}`;
  }

  /** The (latest) contradiction for this decision pair, whatever its status. */
  forPair(a: string, b: string): Contradiction | undefined {
    const r = this.db
      .select()
      .from(contradictions)
      .where(eq(contradictions.dedupeKey, ContradictionService.pairKey(a, b)))
      .get();
    return r ? map(r) : undefined;
  }

  /** The (possibly LLM-confirmed) finding for two decisions, or null: a stored or fresh LLM verdict decides, offline the lexical check does. */
  private async evaluate(pair: [Decision, Decision], budget: ReviewBudget, signal?: AbortSignal): Promise<Finding | null> {
    const lexical = compareLexically(pair[0].decisionText, pair[1].decisionText);
    const lexicalFinding = lexical?.conflict ? { reason: lexical.reason, confidence: lexical.confidence } : null;
    const review = await this.reviewer.review(pair, budget, signal);
    if (!review) return lexicalFinding;
    if (!review.isContradiction) return null;
    return {
      reason: review.description || lexicalFinding?.reason || 'Die Entscheidungen widersprechen sich.',
      confidence: Math.max(lexicalFinding?.confidence ?? 0, review.confidence),
    };
  }

  private activeDecisions(): Decision[] {
    return this.deps.decisions.list().filter((d) => ACTIVE_DECISION_STATUSES.includes(d.status));
  }

  /** Checks a (new) decision against the active decisions on the same topic or in the same project. */
  async checkDecision(decisionId: string, signal?: AbortSignal): Promise<Contradiction[]> {
    const d = this.deps.decisions.get(decisionId);
    if (!ACTIVE_DECISION_STATUSES.includes(d.status)) return [];
    const budget = { left: MAX_REVIEWS_PER_CHECK };
    const created: Contradiction[] = [];
    for (const o of this.activeDecisions().filter((other) => other.id !== d.id && sharesScope(d, other))) {
      if (this.forPair(d.id, o.id)) continue;
      signal?.throwIfAborted();
      const found = await this.evaluate([d, o], budget, signal);
      if (found) created.push(await this.record([d, o], found));
    }
    return created;
  }

  /** Archive check: all active decisions pairwise per topic and project, pairs already recorded not again; outdated contradictions are resolved. */
  async scanAll(signal?: AbortSignal): Promise<Contradiction[]> {
    this.reconcile();
    const budget = { left: MAX_REVIEWS_PER_SCAN };
    await this.reviewRecorded(budget, signal);
    const created: Contradiction[] = [];
    for (const [d, o] of relatedPairs(this.activeDecisions())) {
      if (this.forPair(d.id, o.id)) continue;
      signal?.throwIfAborted();
      const found = await this.evaluate([d, o], budget, signal);
      if (found) created.push(await this.record([d, o], found));
    }
    return created;
  }

  /** Contradictions found without the LLM (offline) are put to it once it is available; a veto closes them as false alarms. */
  private async reviewRecorded(budget: ReviewBudget, signal?: AbortSignal): Promise<void> {
    const open = this.db
      .select()
      .from(contradictions)
      .all()
      .filter((c) => c.status === 'detected');
    for (const c of open) {
      const [a, b] = c.affectedEntityIds.map((id) => this.deps.decisions.get(id));
      if (!a || !b || this.reviewer.stored([a, b]) !== undefined) continue;
      signal?.throwIfAborted();
      const review = await this.reviewer.review([a, b], budget, signal);
      if (review && !review.isContradiction)
        this.close(c.id, { resolution: 'false_positive', by: 'system', reason: 'Die KI-Prüfung bestätigt keinen Widerspruch.' });
    }
  }

  /** Open contradictions whose decisions are no longer both active are resolved (with their insight and proposal). */
  private reconcile(): void {
    const open = this.db
      .select()
      .from(contradictions)
      .all()
      .filter((c) => c.status === 'detected' || c.status === 'acknowledged');
    for (const c of open) {
      const stillActive = c.affectedEntityIds.every((id) => {
        try {
          return ACTIVE_DECISION_STATUSES.includes(this.deps.decisions.get(id).status);
        } catch {
          return false;
        }
      });
      if (!stillActive) this.close(c.id, { resolution: 'resolved', by: 'system', reason: 'Eine der beiden Entscheidungen ist nicht mehr aktiv.' });
    }
  }

  /** After the older decision was superseded by the newer one: the pair's contradiction is resolved. */
  settlePair(oldId: string, newId: string): void {
    const c = this.forPair(oldId, newId);
    if (c && (c.status === 'detected' || c.status === 'acknowledged'))
      this.close(c.id, { resolution: 'resolved', by: 'system', reason: 'Die ältere Entscheidung wurde ersetzt.', supersede: true });
  }

  /** Shared lifecycle: contradiction, its notification, its insight and its proposal are closed together. */
  private close(id: string, closing: { resolution: 'resolved' | 'false_positive'; by: 'user' | 'system'; reason: string; supersede?: boolean }): void {
    const { resolution, by, reason } = closing;
    this.db
      .update(contradictions)
      .set({ status: resolution, resolvedAt: nowIso(), resolvedBySupersede: closing.supersede ?? false })
      .where(eq(contradictions.id, id))
      .run();
    this.settleRelation(id, { resolution, by });
    this.deps.notifications.resolveByDedupePrefix(`contradiction:${id}`);
    this.deps.insights.settle(`contradiction:${id}`, {
      status: resolution === 'resolved' ? 'accepted' : 'rejected',
      reason: `Der Widerspruch wurde bereits aufgelöst: ${reason}`,
    });
    this.deps.ctx.events.changed('contradictions', 'insights');
  }

  /** The pair's still proposed „widerspricht“ relation follows the contradiction: outdated when resolved, rejected as a false alarm (#189). */
  private settleRelation(id: string, { resolution, by }: { resolution: 'resolved' | 'false_positive'; by: 'user' | 'system' }): void {
    const [first, second] = this.get(id).affectedEntityIds;
    if (!first || !second) return;
    const proposed = this.deps.graph.relationsOf(first, { statuses: ['proposed'], types: ['contradicts'] });
    for (const relation of proposed.filter((r) => [r.sourceEntityId, r.targetEntityId].includes(second)))
      this.deps.graph.setRelationStatus(relation.id, resolution === 'resolved' ? { status: 'outdated', by: 'system' } : { status: 'rejected', by });
  }

  /** A contradiction found elsewhere (the LLM's refinement of a link, #284), recorded like one of the own check; an existing one is returned. */
  async recordPair(pair: { aId: string; bId: string }, finding: Finding): Promise<Contradiction> {
    const decisions: [Decision, Decision] = [this.deps.decisions.get(pair.aId), this.deps.decisions.get(pair.bId)];
    this.reviewer.remember(decisions, true);
    return this.record(decisions, finding);
  }

  /** An undone supersede makes both decisions active again: a contradiction it had resolved is open again, with its insight and proposal. */
  private reopenAfterUndo(decisionIds: string[]): void {
    for (const [index, first] of decisionIds.entries())
      for (const second of decisionIds.slice(index + 1)) {
        const resolved = this.forPair(first, second);
        const row = resolved && this.db.select().from(contradictions).where(eq(contradictions.id, resolved.id)).get();
        if (!row?.resolvedBySupersede || row.status !== 'resolved') continue;
        const decisions = row.affectedEntityIds.map((id) => this.deps.decisions.get(id));
        if (!decisions.every((d) => ACTIVE_DECISION_STATUSES.includes(d.status))) continue;
        this.reopen(row, decisions as [Decision, Decision]);
      }
  }

  private reopen(row: ContradictionRow, [older, newer]: [Decision, Decision]): void {
    this.db.update(contradictions).set({ status: 'detected', resolvedAt: null, resolvedBySupersede: false }).where(eq(contradictions.id, row.id)).run();
    this.deps.insights.retire(`contradiction:${row.id}`, 'Die Ersetzung wurde rückgängig gemacht.');
    this.deps.graph.link({ sourceId: newer.id, targetId: older.id, relationType: 'contradicts' }, { confidence: row.confidence, status: 'proposed' });
    const order = orderDecisions(this.db, [older, newer]);
    const action = order.ordered ? proposeSupersede(this.actions, order, row.confidence) : null;
    announce(this.deps, { ...row, status: 'detected', resolvedAt: null }, { older: order.older, newer: order.newer, action });
    this.deps.ctx.events.changed('contradictions', 'insights', 'knowledge');
  }

  private async record([a, b]: [Decision, Decision], { reason, confidence }: Finding): Promise<Contradiction> {
    const dedupeKey = ContradictionService.pairKey(a.id, b.id);
    const existing = this.db.select().from(contradictions).where(eq(contradictions.dedupeKey, dedupeKey)).get();
    if (existing) return map(existing);
    const order = orderDecisions(this.db, [a, b]);
    const { older, newer, ordered, label } = order;
    const topic = a.topicName ?? b.topicName ?? a.projectName ?? 'diesem Thema';
    const orderNote = ordered
      ? ''
      : '\n\nWelche Entscheidung die neuere ist, ist unbekannt – ergänze ein Entscheidungsdatum oder markiere die überholte Entscheidung auf ihrer Seite als „ersetzt“.';
    const row: ContradictionRow = {
      id: newId(),
      title: `Mögliche widersprüchliche Entscheidungen zu „${topic}“`,
      description: `${reason}\n\n1. ${label(older)}: ${truncate(older.decisionText, 240)}\n2. ${label(newer)}: ${truncate(newer.decisionText, 240)}${orderNote}`,
      affectedEntityIds: [older.id, newer.id],
      excerpts: [
        { entityId: older.id, text: truncate(older.decisionText, 300) },
        { entityId: newer.id, text: truncate(newer.decisionText, 300) },
      ] as ArchivistJson,
      sourceIds: [...new Set([...older.sourceIds, ...newer.sourceIds, older.id, newer.id])],
      timestamps: [older, newer].flatMap((d) => order.dateOf(d) ?? []),
      confidence,
      status: 'detected',
      dedupeKey,
      createdAt: nowIso(),
      resolvedAt: null,
      resolvedBySupersede: false,
    };
    this.db.insert(contradictions).values(row).run();
    // one proposal per pair: the contradiction replaces a "possibly superseded" hint of the archive check
    for (const key of [`superseded:${older.id}:${newer.id}`, `superseded:${newer.id}:${older.id}`])
      this.deps.insights.retire(key, 'Für diese Entscheidungen wurde ein Widerspruch erkannt; er ersetzt den Hinweis.');
    this.deps.graph.link({ sourceId: newer.id, targetId: older.id, relationType: 'contradicts' }, { confidence, status: 'proposed' });
    // without a known order there is no direction to propose: the user decides on the decision page
    const action = ordered ? proposeSupersede(this.actions, order, confidence) : null;
    announce(this.deps, row, { older, newer, action });
    this.deps.ctx.events.changed('contradictions', 'insights', 'knowledge');
    return map(row);
  }

  resolve(
    id: string,
    {
      resolution,
      ...opts
    }: { resolution: 'acknowledged' | 'resolved' | 'false_positive'; confirmed: boolean; supersedeOldDecisionId?: string; supersedeNewDecisionId?: string },
  ): Contradiction {
    if (!opts.confirmed) throw new AppError('permission_error', 'Widersprüche dürfen nur nach ausdrücklicher Bestätigung aufgelöst werden.');
    const c = this.get(id);
    if (opts.supersedeOldDecisionId && opts.supersedeNewDecisionId) {
      this.deps.decisions.supersede({ oldId: opts.supersedeOldDecisionId, newId: opts.supersedeNewDecisionId, confirmed: true, trigger: 'contradiction' });
    }
    if (resolution === 'acknowledged') {
      this.db.update(contradictions).set({ status: resolution, resolvedAt: null }).where(eq(contradictions.id, id)).run();
      this.deps.ctx.events.changed('contradictions', 'insights');
    } else
      this.close(id, {
        resolution,
        by: 'user',
        reason: resolution === 'resolved' ? 'Er wurde als aufgelöst markiert.' : 'Er wurde als Fehlalarm markiert.',
        supersede: resolution === 'resolved' && Boolean(opts.supersedeOldDecisionId && opts.supersedeNewDecisionId),
      });
    return this.get(c.id);
  }
}
