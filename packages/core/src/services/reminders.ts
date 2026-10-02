import { localDate, localInstant, type Reminder } from '@archivist/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Db } from '../db/database';
import { openItems, reminders } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { NotificationService } from './notifications';
import type { SettingsService } from './settings';

type Row = typeof reminders.$inferSelect;
const REMINDER_PREFIX = 'Erinnerung: ';
const map = (r: Row): Reminder => ({
  id: r.id,
  targetType: r.targetType as Reminder['targetType'],
  targetId: r.targetId,
  title: r.title,
  remindAt: r.remindAt,
  status: r.status as Reminder['status'],
  createdAt: r.createdAt,
});

function reached(remindAt: string, now: Date, defaultTime: string, timeZone?: string): boolean {
  const at = localInstant(remindAt, defaultTime, timeZone);
  return !at || at.getTime() <= now.getTime();
}

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
    private readonly settings: SettingsService,
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

  /**
   * Whether a reminder time has been reached (#77): a date without a time means the configured
   * local reminder time (default 08:00) on that day, not midnight UTC. Unparsable values count as due.
   */
  isDue(remindAt: string, now: Date = new Date(), timeZone?: string): boolean {
    return reached(remindAt, now, this.settings.get().notifications.reminderTime, timeZone);
  }

  /** Löst fällige Erinnerungen aus (Start der Anwendung und periodisch). Gibt die Anzahl zurück. */
  checkDue(now: Date = new Date(), timeZone?: string): number {
    const pending = this.db.select().from(reminders).where(eq(reminders.status, 'pending')).orderBy(asc(reminders.remindAt)).all();
    const time = this.settings.get().notifications.reminderTime;
    const due = pending.filter((r) => reached(r.remindAt, now, time, timeZone));
    for (const r of due) {
      this.db.update(reminders).set({ status: 'fired' }).where(eq(reminders.id, r.id)).run();
      if (r.targetType === 'open_item' && r.targetId) syncReminderAt(this.db, r.targetId);
      // A snoozed notification comes back as itself, keeping its actions and target (#79).
      if (r.targetType === 'notification' && r.targetId && this.notifications.reopen(r.targetId)) continue;
      const link: { label: string; kind: 'navigate' | 'resolve' | 'snooze'; target?: string }[] = [];
      if (r.targetType === 'open_item') link.push({ label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' });
      if (r.targetType === 'decision') link.push({ label: 'Entscheidungen öffnen', kind: 'navigate', target: '/decisions/' });
      if (r.targetType === 'insight') link.push({ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' });
      this.notifications.create({
        title: r.title.startsWith(REMINDER_PREFIX) ? r.title : `${REMINDER_PREFIX}${r.title}`,
        description: `Geplant für ${localDate(r.remindAt, timeZone)}.`,
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
