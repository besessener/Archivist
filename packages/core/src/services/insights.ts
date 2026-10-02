import type { EntityRef, Insight, InsightChoice, InsightKind } from '@archivist/shared';
import { desc, eq, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { insights } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { ActionService } from './actions';
import { InsightAnswers } from './insight-answers';
import { InsightProposals, type InsightActionSpec, type InsightChoiceSpec, type ProposalInput } from './insight-proposals';
import type { ReminderService } from './reminders';

type Row = typeof insights.$inferSelect;

/** An accepted insight whose cause still exists after this long is shown again (accepting must not hide a problem forever). */
const REOPEN_ACCEPTED_AFTER_MS = 7 * 86_400_000;

export type { InsightChoiceSpec };

export interface InsightInput extends ProposalInput {
  kind: InsightKind;
  title: string;
  explanation: string;
  confidence: number;
  affected?: EntityRef[];
  sourceIds?: string[];
  /** stable: kind of finding plus the id of the affected object */
  dedupeKey: string;
}

const map = (r: Row): Insight => ({
  id: r.id,
  kind: r.kind as InsightKind,
  title: r.title,
  explanation: r.explanation,
  confidence: r.confidence,
  affected: r.affected as EntityRef[],
  sourceIds: r.sourceIds,
  recommendedActionId: r.recommendedActionId,
  recommendedActionLabel: r.recommendedActionLabel,
  choices: r.choices as InsightChoice[],
  chosenChoiceId: r.chosenChoiceId,
  status: r.status as Insight['status'],
  snoozedUntil: r.snoozedUntil,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Hints created by the agent (assignments, duplicates, contradictions, …) with confirm/reject/later. */
export class InsightService {
  private actions!: ActionService;
  private proposals!: InsightProposals;
  private answers!: InsightAnswers;
  private reminders!: ReminderService;
  private readonly rejectedListeners: Array<(dedupeKey: string) => void> = [];

  constructor(private readonly ctx: AppContext) {}

  wire(deps: { actions: ActionService; reminders: ReminderService }): void {
    this.actions = deps.actions;
    this.proposals = new InsightProposals(deps.actions);
    this.answers = new InsightAnswers(this.ctx, {
      actions: deps.actions,
      proposals: this.proposals,
      records: { get: (id) => this.get(id), remove: (row, reason) => this.remove(row, reason), notifyRejected: (id) => this.notifyRejected(id) },
    });
    this.reminders = deps.reminders;
    // an insight whose recommended action was withdrawn is outdated as well; the next archive check re-evaluates it
    this.actions.onWithdrawn((a) => {
      const rows = this.db.select().from(insights).where(eq(insights.recommendedActionId, a.id)).all();
      for (const r of rows.filter((x) => x.status === 'open' || x.status === 'snoozed')) this.db.delete(insights).where(eq(insights.id, r.id)).run();
      // a question one of whose answers is outdated is removed together with the other answers' proposals
      const questions = this.withChoiceAction(a.id).filter((x) => (x.status === 'open' || x.status === 'snoozed') && !this.answers.isAnswering(x.id));
      for (const r of questions) this.remove(r, 'Eine andere Antwort ist nicht mehr aktuell.');
      if (rows.length) this.ctx.events.changed('insights', 'status');
    });
  }

  /** Called when the user rejects an insight (e.g. so that the contradiction behind it is closed as well). */
  onRejected(listener: (dedupeKey: string) => void): void {
    this.rejectedListeners.push(listener);
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Creates an insight or updates the open one with the same key; rejected ones stay closed, accepted ones reopen only for new causes. */
  upsert(input: InsightInput): Insight {
    const existing = this.db.select().from(insights).where(eq(insights.dedupeKey, input.dedupeKey)).get();
    const now = nowIso();
    if (!existing) return this.create(input, now);
    if (this.staysDecided(existing, { input, now })) {
      // the user already decided: a proposal made for this insight would be orphaned
      if (input.recommendedActionId && input.recommendedActionId !== existing.recommendedActionId)
        this.actions.withdraw(input.recommendedActionId, 'Zu diesem Hinweis wurde bereits entschieden.');
      return map(existing);
    }
    const { actionId, actionLabel, replaced } = this.proposals.recommendation({ input, existing });
    const answers = this.proposals.answers({ input, existing });
    this.db
      .update(insights)
      .set({
        title: input.title,
        explanation: input.explanation,
        confidence: input.confidence,
        affected: input.affected ?? [],
        sourceIds: input.sourceIds ?? existing.sourceIds,
        recommendedActionId: actionId,
        recommendedActionLabel: actionLabel,
        choices: answers.choices,
        // a reopened question is unanswered again
        chosenChoiceId: null,
        status: 'open',
        snoozedUntil: null,
        updatedAt: now,
      })
      .where(eq(insights.id, existing.id))
      .run();
    // withdrawn only after the insight points to its successor, so the insight itself stays
    for (const old of [replaced, ...answers.replaced]) if (old) this.actions.withdraw(old, 'Durch einen aktuelleren Vorschlag ersetzt.');
    if (existing.status !== 'open') this.ctx.events.changed('insights', 'status');
    return this.get(existing.id);
  }

  private create(input: InsightInput, now: string): Insight {
    const { actionId, actionLabel } = this.proposals.recommendation({ input, existing: undefined });
    const { choices } = this.proposals.answers({ input, existing: undefined });
    const row: Row = {
      id: newId(),
      kind: input.kind,
      title: input.title,
      explanation: input.explanation,
      confidence: input.confidence,
      affected: input.affected ?? [],
      sourceIds: input.sourceIds ?? [],
      recommendedActionId: actionId,
      recommendedActionLabel: actionLabel,
      choices,
      chosenChoiceId: null,
      status: 'open',
      snoozedUntil: null,
      dedupeKey: input.dedupeKey,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(insights).values(row).run();
    this.ctx.events.changed('insights', 'status');
    return map(row);
  }

  /** A closed insight stays closed unless its snooze is over or an accepted one has to be reopened. */
  private staysDecided(existing: Row, change: { input: InsightInput; now: string }): boolean {
    if (existing.status === 'open') return false;
    const wakes = existing.status === 'snoozed' && existing.snoozedUntil !== null && this.snoozeOver(existing.snoozedUntil);
    const reopens = existing.status === 'accepted' && this.shouldReopen(existing, change);
    return !wakes && !reopens;
  }

  /** New affected objects, or the cause still exists long after the user accepted the insight. */
  private shouldReopen(existing: Row, { input, now }: { input: InsightInput; now: string }): boolean {
    const known = new Set([...existing.sourceIds, ...(existing.affected as EntityRef[]).map((e) => e.id)]);
    const incoming = input.sourceIds?.length ? input.sourceIds : (input.affected ?? []).map((e) => e.id);
    if (incoming.some((id) => !known.has(id))) return true;
    return Date.parse(existing.updatedAt) <= Date.parse(now) - REOPEN_ACCEPTED_AFTER_MS;
  }

  /** Insights with an answer that proposes this action. */
  private withChoiceAction(actionId: string): Row[] {
    return this.db
      .select()
      .from(insights)
      .where(sql`${insights.choices} != '[]'`)
      .all()
      .filter((r) => (r.choices as InsightChoice[]).some((c) => c.actionId === actionId));
  }

  /** After a check run: insights of a key prefix whose cause no longer exists are removed (and reported again if it reappears). */
  reconcile(prefix: string, currentKeys: Set<string>): void {
    const rows = this.db
      .select()
      .from(insights)
      .where(like(insights.dedupeKey, `${prefix}%`))
      .all()
      .filter((r) => !currentKeys.has(r.dedupeKey));
    for (const r of rows) this.remove(r, 'Die Ursache besteht nicht mehr.');
  }

  /** Removes the insight with this key (whatever its status) and withdraws its open proposal. */
  retire(dedupeKey: string, reason: string): void {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, dedupeKey)).get();
    if (r) this.remove(r, reason);
  }

  private remove(r: Row, reason: string): void {
    this.db.delete(insights).where(eq(insights.id, r.id)).run();
    this.proposals.withdrawAll(r, { reason });
    this.ctx.events.changed('insights', 'status');
  }

  /** Closes an open insight whose matter was decided elsewhere; its open proposal is withdrawn. */
  settle(dedupeKey: string, status: 'accepted' | 'rejected', reason: string): void {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, dedupeKey)).get();
    if (!r || (r.status !== 'open' && r.status !== 'snoozed')) return;
    this.db.update(insights).set({ status, snoozedUntil: null, updatedAt: nowIso() }).where(eq(insights.id, r.id)).run();
    this.proposals.withdrawAll(r, { reason });
    this.ctx.events.changed('insights', 'status');
  }

  byDedupeKey(key: string): Insight | undefined {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, key)).get();
    return r ? map(r) : undefined;
  }

  get(id: string): Insight {
    const r = this.db.select().from(insights).where(eq(insights.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Insight nicht gefunden.');
    return map(r);
  }

  list(status?: Insight['status']): Insight[] {
    this.wakeSnoozed();
    return this.db
      .select()
      .from(insights)
      .where(status ? eq(insights.status, status) : undefined)
      .orderBy(desc(insights.updatedAt))
      .all()
      .map(map);
  }

  openCount(): number {
    return this.list('open').length;
  }

  /** A snoozed insight wakes up together with its reminder: a date-only value at the local reminder time (#77). */
  private snoozeOver(snoozedUntil: string): boolean {
    return this.reminders.isDue(snoozedUntil);
  }

  private wakeSnoozed(): void {
    for (const r of this.db.select().from(insights).where(eq(insights.status, 'snoozed')).all()) {
      if (r.snoozedUntil && this.snoozeOver(r.snoozedUntil))
        this.db.update(insights).set({ status: 'open', snoozedUntil: null }).where(eq(insights.id, r.id)).run();
    }
  }

  /** Accept: executes the recommended action (only with confirmation) and marks the insight as accepted. */
  async accept(id: string, opts: { strongConfirmed?: boolean }): Promise<Insight> {
    return this.answers.accept(id, opts);
  }

  async reject(id: string): Promise<Insight> {
    const i = this.get(id);
    if (i.recommendedActionId) {
      try {
        await this.actions.resolve(i.recommendedActionId, 'reject', {});
      } catch {
        /* already decided */
      }
    }
    this.db.update(insights).set({ status: 'rejected', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.proposals.withdrawAll({ recommendedActionId: null, choices: i.choices }, { reason: 'Der Hinweis wurde abgelehnt.' });
    this.notifyRejected(id);
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  private notifyRejected(id: string): void {
    const key = this.db.select({ k: insights.dedupeKey }).from(insights).where(eq(insights.id, id)).get()?.k;
    if (key) for (const listener of this.rejectedListeners) listener(key);
  }

  /** Answers a question insight with one of its `choices`; the proposals of the other answers are withdrawn. */
  async choose(id: string, choiceId: string, opts: { strongConfirmed?: boolean } = {}): Promise<Insight> {
    return this.answers.choose(id, { choiceId, ...opts });
  }

  remindLater(id: string, remindAt: string): Insight {
    const i = this.get(id);
    this.db.update(insights).set({ status: 'snoozed', snoozedUntil: remindAt, updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.reminders.create({ targetType: 'insight', targetId: id, title: i.title, remindAt });
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }
}
