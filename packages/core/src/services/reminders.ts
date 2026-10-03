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
/** The action that opens the reminder's target, for targets that have a view. */
const OPEN_TARGET_ACTIONS = new Map<string, { label: string; kind: 'navigate'; target: string }>([
  ['open_item', { label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' }],
  ['decision', { label: 'Entscheidungen öffnen', kind: 'navigate', target: '/decisions/' }],
  ['insight', { label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
]);
const map = (r: Row): Reminder => ({
  id: r.id,
  targetType: r.targetType as Reminder['targetType'],
  targetId: r.targetId,
  title: r.title,
  remindAt: r.remindAt,
  status: r.status as Reminder['status'],
  createdAt: r.createdAt,
});

function reached(remindAt: string, clock: { now: Date; defaultTime: string; timeZone?: string }): boolean {
  const at = localInstant(remindAt, clock.defaultTime, clock.timeZone);
  return !at || at.getTime() <= clock.now.getTime();
}

/** openItems.reminderAt mirrors the item's next pending reminder (or null). */
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

export interface ReminderServiceDeps {
  ctx: AppContext;
  notifications: NotificationService;
  settings: SettingsService;
}

/** Reminders are stored locally and fired on schedule while the app runs (no notification while it is closed). */
export class ReminderService {
  private timer: NodeJS.Timeout | null = null;

  private readonly ctx: AppContext;
  private readonly notifications: NotificationService;
  private readonly settings: SettingsService;

  constructor(deps: ReminderServiceDeps) {
    ({ ctx: this.ctx, notifications: this.notifications, settings: this.settings } = deps);
  }

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

  /** The most recently scheduled, not dismissed reminder of a target (also if already fired) – for snoozing. */
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

  /** Whether a reminder time has been reached (#77): a bare date means the local reminder time; unparsable counts as due. */
  isDue(remindAt: string, at: { now?: Date; timeZone?: string } = {}): boolean {
    return reached(remindAt, { now: at.now ?? new Date(), defaultTime: this.settings.get().notifications.reminderTime, timeZone: at.timeZone });
  }

  /** Fires due reminders (on application start and periodically). Returns the count. */
  checkDue(now: Date = new Date(), timeZone?: string): number {
    const pending = this.db.select().from(reminders).where(eq(reminders.status, 'pending')).orderBy(asc(reminders.remindAt)).all();
    const clock = { now, defaultTime: this.settings.get().notifications.reminderTime, timeZone };
    const due = pending.filter((r) => reached(r.remindAt, clock));
    for (const reminder of due) this.fire(reminder, timeZone);
    if (due.length) this.ctx.events.changed('reminders', 'openItems');
    return due.length;
  }

  private fire(reminder: Row, timeZone: string | undefined): void {
    this.db.update(reminders).set({ status: 'fired' }).where(eq(reminders.id, reminder.id)).run();
    if (reminder.targetType === 'open_item' && reminder.targetId) syncReminderAt(this.db, reminder.targetId);
    // A snoozed notification comes back as itself, keeping its actions and target (#79).
    if (reminder.targetType === 'notification' && reminder.targetId && this.notifications.reopen(reminder.targetId)) return;
    const open = OPEN_TARGET_ACTIONS.get(reminder.targetType);
    this.notifications.create({
      title: reminder.title.startsWith(REMINDER_PREFIX) ? reminder.title : `${REMINDER_PREFIX}${reminder.title}`,
      description: `Geplant für ${localDate(reminder.remindAt, timeZone)}.`,
      type: 'reminder',
      priority: 'high',
      affectedEntityIds: reminder.targetId ? [reminder.targetId] : [],
      proposedActions: [...(open ? [open] : []), { label: 'Morgen erneut', kind: 'snooze' }, { label: 'Erledigt', kind: 'resolve' }],
      dedupeKey: `reminder:${reminder.id}:${reminder.remindAt}`,
    });
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
