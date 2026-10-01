import type { Reminder } from '@archivist/shared';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Db } from '../db/database';
import { openItems, reminders } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { NotificationService } from './notifications';

type Row = typeof reminders.$inferSelect;
const map = (r: Row): Reminder => ({
  id: r.id,
  targetType: r.targetType as Reminder['targetType'],
  targetId: r.targetId,
  title: r.title,
  remindAt: r.remindAt,
  status: r.status as Reminder['status'],
  createdAt: r.createdAt,
});

/** openItems.reminderAt spiegelt die nächste noch ausstehende Erinnerung des Punkts (oder null). */
export function syncReminderAt(db: Db, openItemId: string): void {
  const next = db
    .select({ remindAt: reminders.remindAt })
    .from(reminders)
    .where(and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, openItemId), eq(reminders.status, 'pending')))
    .orderBy(asc(reminders.remindAt))
    .limit(1)
    .get();
  db.update(openItems)
    .set({ reminderAt: next?.remindAt ?? null })
    .where(eq(openItems.id, openItemId))
    .run();
}

/**
 * Erinnerungen werden lokal gespeichert, beim Start geprüft und – solange die Anwendung läuft – zeitgesteuert ausgelöst.
 * (Ohne Tray-/Betriebssystemdienst gibt es keine Benachrichtigung bei beendeter Anwendung.)
 */
export class ReminderService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly notifications: NotificationService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  create(input: { targetType: Reminder['targetType']; targetId: string | null; title: string; remindAt: string }): Reminder {
    const row: Row = {
      id: newId(),
      targetType: input.targetType,
      targetId: input.targetId,
      title: input.title,
      remindAt: input.remindAt,
      status: 'pending',
      createdAt: nowIso(),
    };
    this.db.insert(reminders).values(row).run();
    if (input.targetType === 'open_item' && input.targetId) syncReminderAt(this.db, input.targetId);
    this.ctx.events.changed('reminders', 'openItems');
    return map(row);
  }

  get(id: string): Reminder {
    const r = this.db.select().from(reminders).where(eq(reminders.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Erinnerung nicht gefunden.');
    return map(r);
  }

  /** Die zuletzt geplante, nicht verworfene Erinnerung eines Ziels (auch bereits ausgelöst) – zum Verschieben. */
  latestFor(targetId: string): Reminder | null {
    return this.list().find((r) => r.targetId === targetId && r.status !== 'dismissed') ?? null;
  }

  list(status?: Reminder['status']): Reminder[] {
    return this.db
      .select()
      .from(reminders)
      .where(status ? eq(reminders.status, status) : undefined)
      .orderBy(desc(reminders.remindAt))
      .limit(500)
      .all()
      .map(map);
  }

  snooze(id: string, remindAt: string): Reminder {
    const r = this.get(id);
    this.db.update(reminders).set({ remindAt, status: 'pending' }).where(eq(reminders.id, id)).run();
    if (r.targetType === 'open_item' && r.targetId) syncReminderAt(this.db, r.targetId);
    this.ctx.events.changed('reminders', 'openItems');
    return { ...r, remindAt, status: 'pending' };
  }

  dismiss(id: string): void {
    const r = this.get(id);
    this.db.update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, id)).run();
    if (r.targetType === 'open_item' && r.targetId) syncReminderAt(this.db, r.targetId);
    this.ctx.events.changed('reminders', 'openItems');
  }

  /** Löst fällige Erinnerungen aus (Start der Anwendung und periodisch). Gibt die Anzahl zurück. */
  checkDue(now: Date = new Date()): number {
    const due = this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.status, 'pending'), lte(reminders.remindAt, now.toISOString())))
      .all();
    for (const r of due) {
      this.db.update(reminders).set({ status: 'fired' }).where(eq(reminders.id, r.id)).run();
      if (r.targetType === 'open_item' && r.targetId) syncReminderAt(this.db, r.targetId);
      const link: { label: string; kind: 'navigate' | 'resolve' | 'snooze'; target?: string }[] = [];
      if (r.targetType === 'open_item') link.push({ label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' });
      if (r.targetType === 'decision') link.push({ label: 'Entscheidungen öffnen', kind: 'navigate', target: '/decisions/' });
      if (r.targetType === 'insight') link.push({ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' });
      this.notifications.create({
        title: `Erinnerung: ${r.title}`,
        description: `Geplant für ${r.remindAt.slice(0, 10)}.`,
        type: 'reminder',
        priority: 'high',
        affectedEntityIds: r.targetId ? [r.targetId] : [],
        proposedActions: [...link, { label: 'Morgen erneut', kind: 'snooze' }, { label: 'Erledigt', kind: 'resolve' }],
        dedupeKey: `reminder:${r.id}:${r.remindAt}`,
      });
    }
    if (due.length) this.ctx.events.changed('reminders', 'openItems');
    return due.length;
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.checkDue();
    this.timer = setInterval(() => this.checkDue(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
