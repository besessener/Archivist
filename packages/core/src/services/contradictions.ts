import type { Contradiction, Decision } from '@archivist/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { contradictions } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { ActionService } from './actions';
import { announce, pairContent, proposeSupersede, type ContradictionRow } from './contradiction-notices';
import { ContradictionReviewer, MAX_REVIEWS_PER_CHECK, MAX_REVIEWS_PER_SCAN, type ReviewRun } from './contradiction-review';
import { countContradictions, isOpenContradiction, listContradictions, openRows, toContradiction, type ContradictionFilter } from './contradiction-list';
import { checkSupersede, type ContradictionResolution } from './contradiction-resolution';
import { compareLexically, relatedPairs, sharesScope } from './contradiction-rules';
import { DocumentContradictionScanner } from './document-contradictions';
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

const DECISION_PAIR_PREFIX = 'decision:';
const REACTIVATED = 'Beide Entscheidungen sind wieder aktiv.';

/** Why a resolved contradiction is raised again later: its supersede is undone, or its decisions are both active again. */
type ReopeningCause = 'supersede' | 'deactivation';

/** Job type of the contradiction scan the chat starts (#254). */
export const CONTRADICTION_SCAN_JOB = 'contradiction.scan';

/** Contradictions are hints: decisions are never revoked or superseded autonomously, the resolution is an action the user confirms. */
export class ContradictionService {
  private actions!: ActionService;
  private readonly reviewer: ContradictionReviewer;
  private readonly documentScanner: DocumentContradictionScanner;

  constructor(private readonly deps: ContradictionServiceDeps) {
    this.reviewer = new ContradictionReviewer(deps);
    this.documentScanner = new DocumentContradictionScanner({ ...deps, reviewer: this.reviewer });
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

  list(filter: ContradictionFilter = {}, page?: { limit: number; offset: number }): Contradiction[] {
    return listContradictions(this.db, filter, page);
  }

  /** Contradictions not settled yet (detected or acknowledged), newest first. */
  listOpen(): Contradiction[] {
    return openRows(this.db).map(toContradiction);
  }

  count(filter: ContradictionFilter = {}): number {
    return countContradictions(this.db, filter);
  }

  get(id: string): Contradiction {
    const r = this.db.select().from(contradictions).where(eq(contradictions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Widerspruch nicht gefunden.');
    return toContradiction(r);
  }

  private static pairKey(a: string, b: string): string {
    return `${DECISION_PAIR_PREFIX}${[a, b].sort().join('|')}`;
  }

  private rowOfPair(a: string, b: string): ContradictionRow | undefined {
    const byKey = eq(contradictions.dedupeKey, ContradictionService.pairKey(a, b));
    return this.db.select().from(contradictions).where(byKey).get();
  }

  /** The (latest) contradiction for this decision pair, whatever its status. */
  forPair(a: string, b: string): Contradiction | undefined {
    const r = this.rowOfPair(a, b);
    return r ? toContradiction(r) : undefined;
  }

  /** The (possibly LLM-confirmed) findings for two decisions, none or one: a stored or fresh LLM verdict decides, offline the lexical check does. */
  private async evaluate(pair: [Decision, Decision], run: ReviewRun): Promise<Finding[]> {
    const lexical = compareLexically(pair[0].decisionText, pair[1].decisionText);
    const lexicalFindings = lexical?.conflict ? [{ reason: lexical.reason, confidence: lexical.confidence }] : [];
    const review = await this.reviewer.review(pair, run);
    if (review.status === 'unavailable') return lexicalFindings;
    if (!review.verdict.isContradiction) return [];
    return [
      {
        reason: review.verdict.description || lexicalFindings[0]?.reason || 'Die Entscheidungen widersprechen sich.',
        confidence: Math.max(lexicalFindings[0]?.confidence ?? 0, review.verdict.confidence),
      },
    ];
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
      for (const found of await this.evaluate([d, o], { budget, signal })) created.push(await this.record([d, o], found));
    }
    return created;
  }

  /** Archive check: all active decisions, then the documents, pairwise per topic and project, pairs already recorded not again; outdated contradictions are resolved. */
  async scanAll(signal?: AbortSignal): Promise<Contradiction[]> {
    this.reconcile();
    const budget = { left: MAX_REVIEWS_PER_SCAN };
    await this.reviewRecorded({ budget, signal });
    const created: Contradiction[] = [];
    for (const [d, o] of relatedPairs(this.activeDecisions())) {
      if (this.forPair(d.id, o.id)) continue;
      signal?.throwIfAborted();
      for (const found of await this.evaluate([d, o], { budget, signal })) created.push(await this.record([d, o], found));
    }
    return [...created, ...(await this.documentScanner.scan(signal)).map(toContradiction)];
  }

  /** Contradictions found without the LLM (offline) are put to it once it is available; a veto closes them as false alarms. */
  private async reviewRecorded(run: ReviewRun): Promise<void> {
    const open = this.db
      .select()
      .from(contradictions)
      .all()
      .filter((c) => c.status === 'detected' && c.dedupeKey.startsWith(DECISION_PAIR_PREFIX));
    for (const c of open) {
      const [a, b] = c.affectedEntityIds.map((id) => this.deps.decisions.get(id));
      if (!a || !b || this.reviewer.stored([a, b]) !== undefined) continue;
      run.signal?.throwIfAborted();
      const review = await this.reviewer.review([a, b], run);
      if (review.status === 'verdict' && !review.verdict.isContradiction)
        this.close(c.id, { resolution: 'false_positive', by: 'system', reason: 'Die KI-Prüfung bestätigt keinen Widerspruch.' });
    }
  }

  /** Open contradictions whose decisions are no longer both active are resolved (with their insight and proposal); ones resolved only for that are raised again once both are active. */
  private reconcile(): void {
    for (const row of this.closedByDeactivation()) this.reopenIfActive(row, REACTIVATED);
    for (const c of openRows(this.db)) {
      const ofDocuments = !c.dedupeKey.startsWith(DECISION_PAIR_PREFIX);
      if (!c.affectedEntityIds.every((id) => (ofDocuments ? this.documentScanner.isCompared(id) : this.isActiveDecision(id))))
        this.close(c.id, {
          resolution: 'resolved',
          by: 'system',
          reason: ofDocuments ? 'Eines der beiden Dokumente gehört nicht mehr zum Archiv.' : 'Eine der beiden Entscheidungen ist nicht mehr aktiv.',
          ...(ofDocuments ? {} : { cause: 'deactivation' as const }),
        });
    }
  }

  private isActiveDecision(id: string): boolean {
    try {
      return ACTIVE_DECISION_STATUSES.includes(this.deps.decisions.get(id).status);
    } catch {
      return false;
    }
  }

  /** After the older decision was superseded by the newer one: the pair's contradiction is resolved. */
  settlePair(oldId: string, newId: string): void {
    const c = this.forPair(oldId, newId);
    if (c && isOpenContradiction(c))
      this.close(c.id, { resolution: 'resolved', by: 'system', reason: 'Die ältere Entscheidung wurde ersetzt.', cause: 'supersede' });
  }

  /** Shared lifecycle: contradiction, its notification, its insight and its proposal are closed together. */
  private close(id: string, closing: { resolution: 'resolved' | 'false_positive'; by: 'user' | 'system'; reason: string; cause?: ReopeningCause }): void {
    const { resolution, by, reason } = closing;
    this.db
      .update(contradictions)
      .set({
        status: resolution,
        resolvedAt: nowIso(),
        resolvedBySupersede: closing.cause === 'supersede',
        resolvedByDeactivation: closing.cause === 'deactivation',
      })
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

  /** An undone supersede or revoke makes the decisions active again: a contradiction it had resolved is open again, with its notice, insight and proposal. */
  private reopenAfterUndo(decisionIds: string[]): void {
    for (const [index, first] of decisionIds.entries())
      for (const second of decisionIds.slice(index + 1)) {
        const row = this.rowOfPair(first, second);
        if (row?.resolvedBySupersede && row.status === 'resolved') this.reopenIfActive(row, 'Die Ersetzung wurde rückgängig gemacht.');
      }
    for (const row of this.closedByDeactivation().filter((c) => c.affectedEntityIds.some((id) => decisionIds.includes(id))))
      this.reopenIfActive(row, REACTIVATED);
  }

  private closedByDeactivation(): ContradictionRow[] {
    return this.db
      .select()
      .from(contradictions)
      .where(and(eq(contradictions.status, 'resolved'), eq(contradictions.resolvedByDeactivation, true)))
      .all();
  }

  private reopenIfActive(row: ContradictionRow, reason: string): void {
    if (!row.affectedEntityIds.every((id) => this.isActiveDecision(id))) return;
    const [older, newer] = row.affectedEntityIds.map((id) => this.deps.decisions.get(id));
    if (older && newer) this.reopen(row, { decisions: [older, newer], reason });
  }

  private reopen(row: ContradictionRow, { decisions: [older, newer], reason }: { decisions: [Decision, Decision]; reason: string }): void {
    this.db
      .update(contradictions)
      .set({ status: 'detected', resolvedAt: null, resolvedBySupersede: false, resolvedByDeactivation: false })
      .where(eq(contradictions.id, row.id))
      .run();
    this.deps.insights.retire(`contradiction:${row.id}`, reason);
    this.deps.graph.link({ sourceId: newer.id, targetId: older.id, relationType: 'contradicts' }, { confidence: row.confidence, status: 'proposed' });
    const order = orderDecisions(this.db, [older, newer]);
    const action = order.ordered ? proposeSupersede(this.actions, { order, confidence: row.confidence }) : null;
    // creating never revives a resolved notice: it is reopened first, so the announcement refreshes it with the new proposal
    const notice = this.deps.notifications.byDedupeKey(`contradiction:${row.id}`);
    if (notice?.resolvedAt) this.deps.notifications.reopen(notice.id);
    announce(this.deps, { ...row, status: 'detected', resolvedAt: null }, { older: order.older, newer: order.newer, action });
    this.deps.ctx.events.changed('contradictions', 'insights', 'knowledge');
  }

  private async record([a, b]: [Decision, Decision], { reason, confidence }: Finding): Promise<Contradiction> {
    const existing = this.rowOfPair(a.id, b.id);
    if (existing) return toContradiction(existing);
    const order = orderDecisions(this.db, [a, b]);
    const { older, newer, ordered } = order;
    const row: ContradictionRow = {
      id: newId(),
      ...pairContent(order, { reason, topic: a.topicName ?? b.topicName ?? a.projectName ?? 'diesem Thema' }),
      confidence,
      status: 'detected',
      dedupeKey: ContradictionService.pairKey(a.id, b.id),
      createdAt: nowIso(),
      resolvedAt: null,
      resolvedBySupersede: false,
      resolvedByDeactivation: false,
    };
    this.db.insert(contradictions).values(row).run();
    // one proposal per pair: the contradiction replaces a "possibly superseded" hint of the archive check
    for (const key of [`superseded:${older.id}:${newer.id}`, `superseded:${newer.id}:${older.id}`])
      this.deps.insights.retire(key, 'Für diese Entscheidungen wurde ein Widerspruch erkannt; er ersetzt den Hinweis.');
    this.deps.graph.link({ sourceId: newer.id, targetId: older.id, relationType: 'contradicts' }, { confidence, status: 'proposed' });
    // without a known order there is no direction to propose: the user decides on the decision page
    const action = ordered ? proposeSupersede(this.actions, { order, confidence }) : null;
    announce(this.deps, row, { older, newer, action });
    this.deps.ctx.events.changed('contradictions', 'insights', 'knowledge');
    return toContradiction(row);
  }

  /** Settles a contradiction the user confirmed; superseding goes only within its own decisions and only with „aufgelöst“. */
  resolve(
    id: string,
    { resolution, ...opts }: { resolution: ContradictionResolution; confirmed: boolean; supersedeOldDecisionId?: string; supersedeNewDecisionId?: string },
  ): Contradiction {
    if (!opts.confirmed) throw new AppError('permission_error', 'Widersprüche dürfen nur nach ausdrücklicher Bestätigung aufgelöst werden.');
    const c = this.get(id);
    const { supersedeOldDecisionId: olderId, supersedeNewDecisionId: newerId } = opts;
    if (olderId && newerId) {
      const check = checkSupersede(c, { resolution, olderId, newerId });
      if (!check.fits) throw new AppError('validation_error', check.reason);
      this.deps.decisions.supersede({ oldId: olderId, newId: newerId, confirmed: true, trigger: 'contradiction' });
    }
    if (resolution === 'acknowledged') {
      this.db.update(contradictions).set({ status: resolution, resolvedAt: null }).where(eq(contradictions.id, id)).run();
      this.deps.ctx.events.changed('contradictions', 'insights');
    } else
      this.close(id, {
        resolution,
        by: 'user',
        reason: resolution === 'resolved' ? 'Er wurde als aufgelöst markiert.' : 'Er wurde als Fehlalarm markiert.',
        ...(resolution === 'resolved' && olderId && newerId ? { cause: 'supersede' as const } : {}),
      });
    return this.get(c.id);
  }
}
