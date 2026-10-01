import type { EntityRef, Insight, InsightChoice, InsightKind } from '@archivist/shared';
import { and, desc, eq, like } from 'drizzle-orm';
import type { AppContext } from '../context';
import { insights } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { ActionService } from './actions';
import type { ReminderService } from './reminders';

type Row = typeof insights.$inferSelect;

export interface InsightInput {
  kind: InsightKind;
  title: string;
  explanation: string;
  confidence: number;
  affected?: EntityRef[];
  sourceIds?: string[];
  recommendedActionId?: string | null;
  recommendedActionLabel?: string | null;
  /**
   * Turns the insight into a question with several answers (see {@link InsightService.choose}). Propose the actions of
   * the choices only when `has(dedupeKey)` is false, otherwise every run would leave unused proposals behind.
   */
  choices?: InsightChoice[];
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

  constructor(private readonly ctx: AppContext) {}

  wire(deps: { actions: ActionService; reminders: ReminderService }): void {
    this.actions = deps.actions;
    this.reminders = deps.reminders;
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Legt einen Insight an. Abgelehnte/akzeptierte Insights mit gleichem Schlüssel werden nicht erneut erzeugt. */
  upsert(input: InsightInput): Insight {
    const existing = this.db.select().from(insights).where(eq(insights.dedupeKey, input.dedupeKey)).get();
    const now = nowIso();
    if (existing) {
      if (existing.status === 'snoozed' && existing.snoozedUntil && existing.snoozedUntil <= now) {
        this.db.update(insights).set({ status: 'open', snoozedUntil: null, updatedAt: now }).where(eq(insights.id, existing.id)).run();
        this.ctx.events.changed('insights', 'status');
        return map({ ...existing, status: 'open', snoozedUntil: null });
      }
      if (existing.status === 'open') {
        this.db
          .update(insights)
          .set({
            title: input.title,
            explanation: input.explanation,
            confidence: input.confidence,
            affected: input.affected ?? [],
            recommendedActionId: input.recommendedActionId ?? existing.recommendedActionId,
            recommendedActionLabel: input.recommendedActionLabel ?? existing.recommendedActionLabel,
            choices: input.choices ?? existing.choices,
            updatedAt: now,
          })
          .where(eq(insights.id, existing.id))
          .run();
      }
      return map(existing);
    }
    const row: Row = {
      id: newId(),
      kind: input.kind,
      title: input.title,
      explanation: input.explanation,
      confidence: input.confidence,
      affected: input.affected ?? [],
      sourceIds: input.sourceIds ?? [],
      recommendedActionId: input.recommendedActionId ?? null,
      recommendedActionLabel: input.recommendedActionLabel ?? null,
      choices: input.choices ?? [],
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

  /** Entfernt offene Insights eines Schlüsselpräfixes, die nicht mehr zutreffen. */
  retireOpen(prefix: string, keepKeys: Set<string>): void {
    const rows = this.db
      .select()
      .from(insights)
      .where(and(like(insights.dedupeKey, `${prefix}%`), eq(insights.status, 'open')))
      .all();
    for (const r of rows) if (!keepKeys.has(r.dedupeKey)) this.db.delete(insights).where(eq(insights.id, r.id)).run();
    if (rows.length) this.ctx.events.changed('insights', 'status');
  }

  byDedupeKey(key: string): Insight | undefined {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, key)).get();
    return r ? map(r) : undefined;
  }

  has(key: string): boolean {
    return Boolean(this.byDedupeKey(key));
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

  private wakeSnoozed(): void {
    const now = nowIso();
    for (const r of this.db.select().from(insights).where(eq(insights.status, 'snoozed')).all()) {
      if (r.snoozedUntil && r.snoozedUntil <= now) this.db.update(insights).set({ status: 'open', snoozedUntil: null }).where(eq(insights.id, r.id)).run();
    }
  }

  /** Bestätigen: führt die empfohlene Aktion aus (nur mit Bestätigung) und markiert den Insight als akzeptiert. */
  async accept(id: string, opts: { strongConfirmed?: boolean }): Promise<Insight> {
    const i = this.get(id);
    if (i.choices.length > 0) throw new AppError('validation_error', 'Bitte wähle eine der Antworten.');
    if (i.recommendedActionId) {
      const res = await this.actions.resolve(i.recommendedActionId, 'approve', { confirmed: true, strongConfirmed: opts.strongConfirmed ?? false });
      if (res.status === 'failed') throw new AppError('validation_error', res.result ?? 'Die Aktion ist fehlgeschlagen.');
    }
    this.db.update(insights).set({ status: 'accepted', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  async reject(id: string): Promise<Insight> {
    const i = this.get(id);
    await this.rejectActions([i.recommendedActionId, ...i.choices.map((c) => c.actionId)]);
    this.db.update(insights).set({ status: 'rejected', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  /**
   * Answers a question insight with one of its `choices`. A choice with an action executes it (the caller has obtained
   * the user's confirmation) and accepts the insight; a choice without an action („verschieden“, „keine davon“) rejects
   * it, so the same question (same dedupe key) is never asked again. The actions of the other choices are rejected.
   */
  async choose(id: string, choiceId: string, opts: { strongConfirmed?: boolean } = {}): Promise<Insight> {
    const i = this.get(id);
    if (i.status === 'accepted' || i.status === 'rejected') throw new AppError('validation_error', 'Diese Frage wurde bereits beantwortet.');
    const choice = i.choices.find((c) => c.id === choiceId);
    if (!choice) throw new AppError('validation_error', 'Diese Antwort gibt es für den Hinweis nicht.');
    if (choice.actionId) {
      const res = await this.actions.resolve(choice.actionId, 'approve', { confirmed: true, strongConfirmed: opts.strongConfirmed ?? false });
      if (res.status !== 'executed')
        throw new AppError(
          'validation_error',
          res.status === 'failed' ? (res.result ?? 'Die Aktion ist fehlgeschlagen.') : 'Die Aktion wurde bereits verworfen.',
        );
    }
    await this.rejectActions(i.choices.filter((c) => c.id !== choice.id).map((c) => c.actionId));
    this.db
      .update(insights)
      .set({ status: choice.actionId ? 'accepted' : 'rejected', chosenChoiceId: choice.id, snoozedUntil: null, updatedAt: nowIso() })
      .where(eq(insights.id, id))
      .run();
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }

  /** Rejects the still proposed actions among `ids` (already decided ones are left as they are). */
  private async rejectActions(ids: Array<string | null>): Promise<void> {
    for (const actionId of new Set(ids)) {
      if (!actionId) continue;
      try {
        await this.actions.resolve(actionId, 'reject', {});
      } catch {
        /* bereits entschieden oder nicht mehr vorhanden */
      }
    }
  }

  remindLater(id: string, remindAt: string): Insight {
    const i = this.get(id);
    this.db.update(insights).set({ status: 'snoozed', snoozedUntil: remindAt, updatedAt: nowIso() }).where(eq(insights.id, id)).run();
    this.reminders.create({ targetType: 'insight', targetId: id, title: i.title, remindAt });
    this.ctx.events.changed('insights', 'status');
    return this.get(id);
  }
}
