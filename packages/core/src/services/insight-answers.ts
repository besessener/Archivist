import type { Insight, InsightChoice, StoredAgentAction } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { insights } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { ActionService } from './actions';
import type { InsightProposals } from './insight-proposals';

type Row = typeof insights.$inferSelect;

/** What the answers need of the insight service: reading, removing and announcing a rejection. */
export interface InsightRecords {
  get: (id: string) => Insight;
  remove: (row: Row, reason: string) => void;
  notifyRejected: (id: string) => void;
}

const OUTDATED = 'Die nächste Archivprüfung bewertet die Lage neu.';

/** Accepting an insight or choosing one of its answers: executes the action behind it (the caller has the user's confirmation). */
export class InsightAnswers {
  /** Questions whose chosen answer is being executed; executing it may withdraw the other answers' proposals. */
  private readonly answering = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly helpers: { actions: ActionService; proposals: InsightProposals; records: InsightRecords },
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  isAnswering(id: string): boolean {
    return this.answering.has(id);
  }

  /** Executes the recommended action (a failed one is retried, an outdated one not) and accepts the insight. */
  async accept(id: string, opts: { strongConfirmed?: boolean }): Promise<Insight> {
    const { actions, records } = this.helpers;
    const i = records.get(id);
    if (i.choices.length > 0) throw new AppError('validation_error', 'Bitte wähle eine der Antworten.');
    let action = i.recommendedActionId ? actions.getMany([i.recommendedActionId])[0] : undefined;
    if (action && (action.status === 'failed' || action.status === 'rejected')) {
      // a failed attempt must not block the insight forever: decide on a fresh copy of the proposal
      action = actions.repropose(action.id);
      this.db.update(insights).set({ recommendedActionId: action.id }).where(eq(insights.id, id)).run();
    }
    if (action) {
      const result =
        action.status === 'withdrawn'
          ? action
          : await actions.resolve(action.id, 'approve', { confirmed: true, strongConfirmed: opts.strongConfirmed ?? false });
      if (result.status === 'failed') throw new AppError('validation_error', result.result ?? 'Die Aktion ist fehlgeschlagen.');
      if (result.status === 'withdrawn') {
        this.db.delete(insights).where(eq(insights.id, id)).run();
        this.ctx.events.changed('insights', 'status');
        throw new AppError('validation_error', `${result.result ?? 'Dieser Vorschlag ist nicht mehr aktuell.'} ${OUTDATED}`);
      }
    }
    this.db.update(insights).set({ status: 'accepted', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.ctx.events.changed('insights', 'status');
    return records.get(id);
  }

  /** An answer with an action executes it; one without („verschieden“) rejects the question, so it is not asked again while its cause exists. */
  async choose(id: string, { choiceId, ...opts }: { choiceId: string; strongConfirmed?: boolean }): Promise<Insight> {
    const { proposals, records } = this.helpers;
    const i = records.get(id);
    if (i.status === 'accepted' || i.status === 'rejected') throw new AppError('validation_error', 'Diese Frage wurde bereits beantwortet.');
    const choice = i.choices.find((c) => c.id === choiceId);
    if (!choice) throw new AppError('validation_error', 'Diese Antwort gibt es für den Hinweis nicht.');
    const choices = choice.actionId
      ? await this.executeChoice(i, { choice, actionId: choice.actionId, strongConfirmed: opts.strongConfirmed ?? false })
      : i.choices;
    const chosenAction = choices.find((c) => c.id === choice.id)?.actionId ?? null;
    const status = chosenAction ? 'accepted' : 'rejected';
    this.db.update(insights).set({ status, chosenChoiceId: choice.id, snoozedUntil: null, updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    // only after the insight is decided, so withdrawing the other answers does not remove it
    proposals.withdrawAll({ recommendedActionId: i.recommendedActionId, choices }, { reason: 'Eine andere Antwort wurde gewählt.', keep: chosenAction });
    if (status === 'rejected') records.notifyRejected(id);
    this.ctx.events.changed('insights', 'status');
    return records.get(id);
  }

  /** Executes the chosen answer's action; a failed one is retried on a fresh copy, an outdated one removes the question. */
  private async executeChoice(insight: Insight, chosen: { choice: InsightChoice; actionId: string; strongConfirmed: boolean }): Promise<InsightChoice[]> {
    const { actions, records } = this.helpers;
    let choices = insight.choices;
    let action = actions.getMany([chosen.actionId])[0];
    if (action && (action.status === 'failed' || action.status === 'rejected')) {
      // a failed attempt must not block the question forever: decide on a fresh copy of the proposal
      const fresh = actions.repropose(action.id);
      choices = choices.map((c) => (c.id === chosen.choice.id ? { ...c, actionId: fresh.id } : c));
      this.db.update(insights).set({ choices }).where(eq(insights.id, insight.id)).run();
      action = fresh;
    }
    const result =
      action && action.status !== 'withdrawn'
        ? await this.resolveAnswering(insight.id, { actionId: action.id, strongConfirmed: chosen.strongConfirmed })
        : action;
    if (result?.status === 'failed') throw new AppError('validation_error', result.result ?? 'Die Aktion ist fehlgeschlagen.');
    if (result?.status !== 'executed') {
      const row = this.db.select().from(insights).where(eq(insights.id, insight.id)).get();
      if (row) records.remove(row, 'Die Frage ist nicht mehr aktuell.');
      throw new AppError('validation_error', `${result?.result ?? 'Dieser Vorschlag ist nicht mehr aktuell.'} ${OUTDATED}`);
    }
    return choices;
  }

  /** E.g. a merge withdraws the other answers' merge proposals of the same entries: that must not remove this question. */
  private async resolveAnswering(insightId: string, approval: { actionId: string; strongConfirmed: boolean }): Promise<StoredAgentAction> {
    this.answering.add(insightId);
    try {
      return await this.helpers.actions.resolve(approval.actionId, 'approve', { confirmed: true, strongConfirmed: approval.strongConfirmed });
    } finally {
      this.answering.delete(insightId);
    }
  }
}
