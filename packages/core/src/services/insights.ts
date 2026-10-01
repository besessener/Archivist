import type { EntityRef, Insight, InsightKind } from '@archivist/shared';
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
    if (i.recommendedActionId) {
      try {
        await this.actions.resolve(i.recommendedActionId, 'reject', {});
      } catch {
        /* bereits entschieden */
      }
    }
    this.db.update(insights).set({ status: 'rejected', updatedAt: nowIso() }).where(eq(insights.id, id)).run();
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
