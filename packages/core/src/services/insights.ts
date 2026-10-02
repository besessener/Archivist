import type { AgentActionProposal, EntityRef, Insight, InsightChoice, InsightKind, StoredAgentAction } from '@archivist/shared';
import { desc, eq, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { insights } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { ActionService } from './actions';
import type { ReminderService } from './reminders';

type Row = typeof insights.$inferSelect;

/** An accepted insight whose cause still exists after this long is shown again (accepting must not hide a problem forever). */
const REOPEN_ACCEPTED_AFTER_MS = 7 * 86_400_000;

/** Recommended action of an insight: proposed only while the insight is open, replaced when its parameters change. */
export interface InsightActionSpec {
  proposal: AgentActionProposal & { label: string };
  /** label of the recommendation shown on the insight */
  label: string;
}

/**
 * One answer of a question insight. `proposal` is the action executed when this answer is chosen; without it, choosing
 * the answer changes nothing and rejects the insight (remembered for as long as its cause exists, e.g. „verschieden“).
 */
export interface InsightChoiceSpec {
  /** stable within the insight; identifies the answer across runs (e.g. `project`, `topic`, `different`, an entity id) */
  id: string;
  label: string;
  /** what happens when this answer is chosen (shown before confirming) */
  description?: string | null;
  proposal?: (AgentActionProposal & { label: string }) | null;
}

export interface InsightInput {
  kind: InsightKind;
  title: string;
  explanation: string;
  confidence: number;
  affected?: EntityRef[];
  sourceIds?: string[];
  recommendedActionId?: string | null;
  recommendedActionLabel?: string | null;
  /** alternative to `recommendedActionId`: the action is only proposed if the insight is (re)opened, never orphaned */
  action?: InsightActionSpec;
  /**
   * Turns the insight into a question with several answers, answered via {@link InsightService.choose}. Like `action`,
   * the answers' actions are only proposed while the insight is open and are withdrawn with it.
   */
  choices?: InsightChoiceSpec[];
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

/** Agentisch erzeugte Hinweise (Zuordnungen, Duplikate, Widersprüche, …) mit Bestätigen/Ablehnen/Später. */
export class InsightService {
  private actions!: ActionService;
  private reminders!: ReminderService;
  private readonly rejectedListeners: Array<(dedupeKey: string) => void> = [];
  /** Questions whose chosen answer is being executed; executing it may withdraw the other answers' proposals. */
  private readonly answering = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  wire(deps: { actions: ActionService; reminders: ReminderService }): void {
    this.actions = deps.actions;
    this.reminders = deps.reminders;
    // an insight whose recommended action was withdrawn is outdated as well; the next archive check re-evaluates it
    this.actions.onWithdrawn((a) => {
      const rows = this.db.select().from(insights).where(eq(insights.recommendedActionId, a.id)).all();
      for (const r of rows.filter((x) => x.status === 'open' || x.status === 'snoozed')) this.db.delete(insights).where(eq(insights.id, r.id)).run();
      // a question one of whose answers is outdated is removed together with the other answers' proposals
      const questions = this.withChoiceAction(a.id).filter((x) => (x.status === 'open' || x.status === 'snoozed') && !this.answering.has(x.id));
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

  /**
   * Legt einen Insight an oder aktualisiert den offenen mit gleichem Schlüssel. Abgelehnte Insights werden nicht erneut
   * geöffnet; bestätigte nur, wenn neue Objekte betroffen sind oder die Ursache Tage nach dem Bestätigen noch besteht.
   */
  upsert(input: InsightInput): Insight {
    const existing = this.db.select().from(insights).where(eq(insights.dedupeKey, input.dedupeKey)).get();
    const now = nowIso();
    if (existing) {
      const wakes = existing.status === 'snoozed' && existing.snoozedUntil !== null && this.snoozeOver(existing.snoozedUntil);
      const reopens = existing.status === 'accepted' && this.shouldReopen(existing, input, now);
      if (existing.status !== 'open' && !wakes && !reopens) {
        // the user already decided: a proposal made for this insight would be orphaned
        if (input.recommendedActionId && input.recommendedActionId !== existing.recommendedActionId)
          this.actions.withdraw(input.recommendedActionId, 'Zu diesem Hinweis wurde bereits entschieden.');
        return map(existing);
      }
      const { actionId, actionLabel, replaced } = this.recommendation(input, existing);
      const answers = this.answers(input, existing);
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
    const { actionId, actionLabel } = this.recommendation(input, undefined);
    const { choices } = this.answers(input, undefined);
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

  /** New affected objects, or the cause still exists long after the user accepted the insight. */
  private shouldReopen(existing: Row, input: InsightInput, now: string): boolean {
    const known = new Set([...existing.sourceIds, ...(existing.affected as EntityRef[]).map((e) => e.id)]);
    const incoming = input.sourceIds?.length ? input.sourceIds : (input.affected ?? []).map((e) => e.id);
    if (incoming.some((id) => !known.has(id))) return true;
    return Date.parse(existing.updatedAt) <= Date.parse(now) - REOPEN_ACCEPTED_AFTER_MS;
  }

  /** Recommended action of an (re)opened insight: keeps the current proposal if it is still undecided and unchanged. */
  private recommendation(input: InsightInput, existing: Row | undefined): { actionId: string | null; actionLabel: string | null; replaced?: string } {
    if (!input.action) {
      const actionId = input.recommendedActionId ?? existing?.recommendedActionId ?? null;
      return {
        actionId,
        actionLabel: input.recommendedActionLabel ?? existing?.recommendedActionLabel ?? null,
        replaced: existing?.recommendedActionId && existing.recommendedActionId !== actionId ? existing.recommendedActionId : undefined,
      };
    }
    const { proposal, label } = input.action;
    const current = existing?.recommendedActionId ? this.actions.getMany([existing.recommendedActionId])[0] : undefined;
    const wanted = JSON.stringify(this.actions.normalizeParams(proposal.actionType, proposal.proposedParameters));
    if (current?.status === 'proposed' && current.actionType === proposal.actionType && JSON.stringify(current.proposedParameters) === wanted)
      return { actionId: current.id, actionLabel: label };
    const action = this.actions.propose(proposal);
    return { actionId: action.id, actionLabel: label, replaced: current?.status === 'proposed' ? current.id : undefined };
  }

  /**
   * Answers of an (re)opened question: an answer keeps its undecided proposal while the parameters are unchanged,
   * otherwise a new one is proposed; proposals of replaced or dropped answers are returned for withdrawal.
   */
  private answers(input: InsightInput, existing: Row | undefined): { choices: InsightChoice[]; replaced: string[] } {
    const before = existing ? (existing.choices as InsightChoice[]) : [];
    if (!input.choices) return { choices: before, replaced: [] };
    const current = new Map(this.actions.getMany(before.flatMap((c) => (c.actionId ? [c.actionId] : []))).map((a) => [a.id, a]));
    const kept = new Set<string>();
    const choices = input.choices.map((spec): InsightChoice => {
      const base = { id: spec.id, label: spec.label, description: spec.description ?? null };
      if (!spec.proposal) return { ...base, actionId: null };
      const prev = before.find((c) => c.id === spec.id)?.actionId;
      const action = prev ? current.get(prev) : undefined;
      if (action && this.sameProposal(action, spec.proposal)) {
        kept.add(action.id);
        return { ...base, actionId: action.id };
      }
      return { ...base, actionId: this.actions.propose(spec.proposal).id };
    });
    const replaced = [...current.values()].filter((a) => a.status === 'proposed' && !kept.has(a.id)).map((a) => a.id);
    return { choices, replaced };
  }

  private sameProposal(current: StoredAgentAction, proposal: AgentActionProposal): boolean {
    const wanted = JSON.stringify(this.actions.normalizeParams(proposal.actionType, proposal.proposedParameters));
    return current.status === 'proposed' && current.actionType === proposal.actionType && JSON.stringify(current.proposedParameters) === wanted;
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

  /** Withdraws the undecided proposals of an insight (recommendation and answers), except `keep`. */
  private withdrawAll(r: { recommendedActionId: string | null; choices: unknown }, reason: string, keep?: string | null): void {
    const ids = [r.recommendedActionId, ...(r.choices as InsightChoice[]).map((c) => c.actionId)];
    for (const id of new Set(ids)) if (id && id !== keep) this.actions.withdraw(id, reason);
  }

  /**
   * Abgleich nach einem Prüflauf: Insights eines Schlüsselpräfixes, deren Ursache nicht mehr besteht, werden entfernt
   * (offene Vorschläge dazu zurückgezogen). Tritt die Ursache später wieder auf, wird sie erneut gemeldet.
   */
  reconcile(prefix: string, currentKeys: Set<string>): void {
    const rows = this.db
      .select()
      .from(insights)
      .where(like(insights.dedupeKey, `${prefix}%`))
      .all()
      .filter((r) => !currentKeys.has(r.dedupeKey));
    for (const r of rows) this.remove(r, 'Die Ursache besteht nicht mehr.');
  }

  /** Entfernt den Insight mit diesem Schlüssel (gleich welchen Status) und zieht seinen offenen Vorschlag zurück. */
  retire(dedupeKey: string, reason: string): void {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, dedupeKey)).get();
    if (r) this.remove(r, reason);
  }

  private remove(r: Row, reason: string): void {
    this.db.delete(insights).where(eq(insights.id, r.id)).run();
    this.withdrawAll(r, reason);
    this.ctx.events.changed('insights', 'status');
  }

  /** Schließt einen offenen Insight, dessen Sache anderweitig entschieden wurde; sein offener Vorschlag wird zurückgezogen. */
  settle(dedupeKey: string, status: 'accepted' | 'rejected', reason: string): void {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, dedupeKey)).get();
    if (!r || (r.status !== 'open' && r.status !== 'snoozed')) return;
    this.db.update(insights).set({ status, snoozedUntil: null, updatedAt: nowIso() }).where(eq(insights.id, r.id)).run();
    this.withdrawAll(r, reason);
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

  /**
   * Bestätigen: führt die empfohlene Aktion aus (nur mit Bestätigung) und markiert den Insight als akzeptiert. Ist die
   * Aktion zuvor fehlgeschlagen, wird sie erneut versucht; ist sie veraltet, wird nichts ausgeführt.
   */
  async accept(id: string, opts: { strongConfirmed?: boolean }): Promise<Insight> {
    const i = this.get(id);
    if (i.choices.length > 0) throw new AppError('validation_error', 'Bitte wähle eine der Antworten.');
    let action = i.recommendedActionId ? this.actions.getMany([i.recommendedActionId])[0] : undefined;
    if (action && (action.status === 'failed' || action.status === 'rejected')) {
      // a failed attempt must not block the insight forever: decide on a fresh copy of the proposal
      action = this.actions.repropose(action.id);
      this.db.update(insights).set({ recommendedActionId: action.id }).where(eq(insights.id, id)).run();
    }
    if (action) {
      const res =
        action.status === 'withdrawn'
          ? action
          : await this.actions.resolve(action.id, 'approve', { confirmed: true, strongConfirmed: opts.strongConfirmed ?? false });
      if (res.status === 'failed') throw new AppError('validation_error', res.result ?? 'Die Aktion ist fehlgeschlagen.');
      if (res.status === 'withdrawn') {
        this.db.delete(insights).where(eq(insights.id, id)).run();
        this.ctx.events.changed('insights', 'status');
        throw new AppError('validation_error', `${res.result ?? 'Dieser Vorschlag ist nicht mehr aktuell.'} Die nächste Archivprüfung bewertet die Lage neu.`);
      }
    }
    this.db.update(insights).set({ status: 'accepted', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  async reject(id: string): Promise<Insight> {
    const i = this.get(id);
    if (i.recommendedActionId) {
      try {
        await this.actions.resolve(i.recommendedActionId, 'reject', {});
      } catch {
        /* bereits entschieden */
      }
    }
    this.db.update(insights).set({ status: 'rejected', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.withdrawAll({ recommendedActionId: null, choices: i.choices }, 'Der Hinweis wurde abgelehnt.');
    this.notifyRejected(id);
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  private notifyRejected(id: string): void {
    const key = this.db.select({ k: insights.dedupeKey }).from(insights).where(eq(insights.id, id)).get()?.k;
    if (key) for (const listener of this.rejectedListeners) listener(key);
  }

  /**
   * Answers a question insight with one of its `choices`. An answer with an action executes it (the caller has the
   * user's confirmation) and accepts the insight; an answer without an action („verschieden“, „keine davon“) rejects it,
   * so the question is not asked again while its cause exists. The proposals of the other answers are withdrawn.
   * A failed proposal is retried on a fresh copy; an outdated one removes the question (the next check re-evaluates).
   */
  async choose(id: string, choiceId: string, opts: { strongConfirmed?: boolean } = {}): Promise<Insight> {
    const i = this.get(id);
    if (i.status === 'accepted' || i.status === 'rejected') throw new AppError('validation_error', 'Diese Frage wurde bereits beantwortet.');
    const choice = i.choices.find((c) => c.id === choiceId);
    if (!choice) throw new AppError('validation_error', 'Diese Antwort gibt es für den Hinweis nicht.');
    let choices = i.choices;
    if (choice.actionId) {
      let action = this.actions.getMany([choice.actionId])[0];
      if (action && (action.status === 'failed' || action.status === 'rejected')) {
        // a failed attempt must not block the question forever: decide on a fresh copy of the proposal
        const fresh = this.actions.repropose(action.id);
        choices = choices.map((c) => (c.id === choice.id ? { ...c, actionId: fresh.id } : c));
        this.db.update(insights).set({ choices }).where(eq(insights.id, id)).run();
        action = fresh;
      }
      let res = action;
      if (action && action.status !== 'withdrawn') {
        // e.g. a merge withdraws the other answers' merge proposals of the same entries: that must not remove this question
        this.answering.add(id);
        try {
          res = await this.actions.resolve(action.id, 'approve', { confirmed: true, strongConfirmed: opts.strongConfirmed ?? false });
        } finally {
          this.answering.delete(id);
        }
      }
      if (res?.status === 'failed') throw new AppError('validation_error', res.result ?? 'Die Aktion ist fehlgeschlagen.');
      if (res?.status !== 'executed') {
        const row = this.db.select().from(insights).where(eq(insights.id, id)).get();
        if (row) this.remove(row, 'Die Frage ist nicht mehr aktuell.');
        throw new AppError('validation_error', `${res?.result ?? 'Dieser Vorschlag ist nicht mehr aktuell.'} Die nächste Archivprüfung bewertet die Lage neu.`);
      }
    }
    const chosenAction = choices.find((c) => c.id === choice.id)?.actionId ?? null;
    const status = chosenAction ? 'accepted' : 'rejected';
    this.db.update(insights).set({ status, chosenChoiceId: choice.id, snoozedUntil: null, updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    // only after the insight is decided, so withdrawing the other answers does not remove it
    this.withdrawAll({ recommendedActionId: i.recommendedActionId, choices }, 'Eine andere Antwort wurde gewählt.', chosenAction);
    if (status === 'rejected') this.notifyRejected(id);
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  remindLater(id: string, remindAt: string): Insight {
    const i = this.get(id);
    this.db.update(insights).set({ status: 'snoozed', snoozedUntil: remindAt, updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.reminders.create({ targetType: 'insight', targetId: id, title: i.title, remindAt });
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }
}
