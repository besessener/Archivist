import type { AgentActionProposal, EntityRef, Insight, InsightKind } from '@archivist/shared';
import { desc, eq, like } from 'drizzle-orm';
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

  constructor(private readonly ctx: AppContext) {}

  wire(deps: { actions: ActionService; reminders: ReminderService }): void {
    this.actions = deps.actions;
    this.reminders = deps.reminders;
    // an insight whose recommended action was withdrawn is outdated as well; the next archive check re-evaluates it
    this.actions.onWithdrawn((a) => {
      const rows = this.db.select().from(insights).where(eq(insights.recommendedActionId, a.id)).all();
      for (const r of rows.filter((x) => x.status === 'open' || x.status === 'snoozed')) this.db.delete(insights).where(eq(insights.id, r.id)).run();
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
      const wakes = existing.status === 'snoozed' && existing.snoozedUntil !== null && existing.snoozedUntil <= now;
      const reopens = existing.status === 'accepted' && this.shouldReopen(existing, input, now);
      if (existing.status !== 'open' && !wakes && !reopens) {
        // the user already decided: a proposal made for this insight would be orphaned
        if (input.recommendedActionId && input.recommendedActionId !== existing.recommendedActionId)
          this.actions.withdraw(input.recommendedActionId, 'Zu diesem Hinweis wurde bereits entschieden.');
        return map(existing);
      }
      const { actionId, actionLabel, replaced } = this.recommendation(input, existing);
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
          status: 'open',
          snoozedUntil: null,
          updatedAt: now,
        })
        .where(eq(insights.id, existing.id))
        .run();
      // withdrawn only after the insight points to its successor, so the insight itself stays
      if (replaced) this.actions.withdraw(replaced, 'Durch einen aktuelleren Vorschlag ersetzt.');
      if (existing.status !== 'open') this.ctx.events.changed('insights', 'status');
      return this.get(existing.id);
    }
    const { actionId, actionLabel } = this.recommendation(input, undefined);
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
    if (r.recommendedActionId) this.actions.withdraw(r.recommendedActionId, reason);
    this.ctx.events.changed('insights', 'status');
  }

  /** Schließt einen offenen Insight, dessen Sache anderweitig entschieden wurde; sein offener Vorschlag wird zurückgezogen. */
  settle(dedupeKey: string, status: 'accepted' | 'rejected', reason: string): void {
    const r = this.db.select().from(insights).where(eq(insights.dedupeKey, dedupeKey)).get();
    if (!r || (r.status !== 'open' && r.status !== 'snoozed')) return;
    this.db.update(insights).set({ status, snoozedUntil: null, updatedAt: nowIso() }).where(eq(insights.id, r.id)).run();
    if (r.recommendedActionId) this.actions.withdraw(r.recommendedActionId, reason);
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

  private wakeSnoozed(): void {
    const now = nowIso();
    for (const r of this.db.select().from(insights).where(eq(insights.status, 'snoozed')).all()) {
      if (r.snoozedUntil && r.snoozedUntil <= now) this.db.update(insights).set({ status: 'open', snoozedUntil: null }).where(eq(insights.id, r.id)).run();
    }
  }

  /**
   * Bestätigen: führt die empfohlene Aktion aus (nur mit Bestätigung) und markiert den Insight als akzeptiert. Ist die
   * Aktion zuvor fehlgeschlagen, wird sie erneut versucht; ist sie veraltet, wird nichts ausgeführt.
   */
  async accept(id: string, opts: { strongConfirmed?: boolean }): Promise<Insight> {
    const i = this.get(id);
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
    const key = this.db.select({ k: insights.dedupeKey }).from(insights).where(eq(insights.id, id)).get()?.k;
    if (key) for (const listener of this.rejectedListeners) listener(key);
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
