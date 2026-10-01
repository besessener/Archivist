import type { Reminder } from '@archivist/shared';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../context';
import { openItems, reminders } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { NotificationService } from './notifications';

type Row = typeof reminders.$inferSelect;
const map = (r: Row): Reminder => ({ id: r.id, targetType: r.targetType as Reminder['targetType'], targetId: r.targetId, title: r.title, remindAt: r.remindAt, status: r.status as Reminder['status'], createdAt: r.createdAt });

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
    const row: Row = { id: newId(), targetType: input.targetType, targetId: input.targetId, title: input.title, remindAt: input.remindAt, status: 'pending', createdAt: nowIso() };
    this.db.insert(reminders).values(row).run();
    if (input.targetType === 'open_item' && input.targetId) this.db.update(openItems).set({ reminderAt: input.remindAt }).where(eq(openItems.id, input.targetId)).run();
    this.ctx.events.changed('reminders', 'openItems');
    return map(row);
  }

  get(id: string): Reminder {
    const r = this.db.select().from(reminders).where(eq(reminders.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Erinnerung nicht gefunden.');
    return map(r);
  }

  list(status?: Reminder['status']): Reminder[] {
    return this.db.select().from(reminders).where(status ? eq(reminders.status, status) : undefined).orderBy(desc(reminders.remindAt)).limit(500).all().map(map);
  }

  snooze(id: string, remindAt: string): Reminder {
    const r = this.get(id);
    this.db.update(reminders).set({ remindAt, status: 'pending' }).where(eq(reminders.id, id)).run();
    if (r.targetType === 'open_item' && r.targetId) this.db.update(openItems).set({ reminderAt: remindAt }).where(eq(openItems.id, r.targetId)).run();
    this.ctx.events.changed('reminders', 'openItems');
    return { ...r, remindAt, status: 'pending' };
  }

  dismiss(id: string): void {
    this.db.update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, id)).run();
    this.ctx.events.changed('reminders');
  }

  /** Löst fällige Erinnerungen aus (Start der Anwendung und periodisch). Gibt die Anzahl zurück. */
  checkDue(now: Date = new Date()): number {
    const due = this.db.select().from(reminders).where(and(eq(reminders.status, 'pending'), lte(reminders.remindAt, now.toISOString()))).all();
    for (const r of due) {
      this.db.update(reminders).set({ status: 'fired' }).where(eq(reminders.id, r.id)).run();
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
    if (due.length) this.ctx.events.changed('reminders');
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
