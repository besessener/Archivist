import { ResolvedNotification, type AppNotification, type NotificationType } from '@archivist/shared';
import { and, desc, eq, isNotNull, isNull, lt, notExists, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { notifications, reminders } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';

type Row = typeof notifications.$inferSelect;

/** Dedupe prefix of the notifications about decisions and open items found in a document. */
export const EXTRACTED_NOTIFICATION_PREFIX = 'extracted:';

/** How many handled notifications „Zuletzt erledigt“ in the bell shows. */
const RECENTLY_RESOLVED_LIMIT = 10;

export interface NotificationInput {
  title: string;
  description: string;
  type: NotificationType;
  priority?: 'low' | 'normal' | 'high';
  affectedEntityIds?: string[];
  proposedActions?: AppNotification['proposedActions'];
  /** Prevents duplicates: the same (unresolved) notification is only updated. */
  dedupeKey?: string;
}

const toNotification = (r: Row): AppNotification => ({
  id: r.id,
  title: r.title,
  description: r.description,
  createdAt: r.createdAt,
  type: r.type as NotificationType,
  priority: r.priority as AppNotification['priority'],
  affectedEntityIds: r.affectedEntityIds,
  proposedActions: r.proposedActions as AppNotification['proposedActions'],
  readAt: r.readAt,
  resolvedAt: r.resolvedAt,
});

/** In-app notifications (notification bell). Desktop notifications are handled by the host layer. */
export class NotificationService {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** The notification with this dedupe key (also a read or resolved one), if any. */
  byDedupeKey(key: string): AppNotification | null {
    const r = this.db.select().from(notifications).where(eq(notifications.dedupeKey, key)).get();
    return r ? toNotification(r) : null;
  }

  create(input: NotificationInput): AppNotification {
    if (input.dedupeKey) {
      const existing = this.db.select().from(notifications).where(eq(notifications.dedupeKey, input.dedupeKey)).get();
      if (existing) {
        if (existing.resolvedAt) return toNotification(existing); // do not revive resolved notifications
        this.db
          .update(notifications)
          .set({
            title: input.title,
            description: input.description,
            proposedActions: input.proposedActions ?? [],
            affectedEntityIds: input.affectedEntityIds ?? [],
            priority: input.priority ?? 'normal',
          })
          .where(eq(notifications.id, existing.id))
          .run();
        this.ctx.events.changed('notifications');
        return toNotification({ ...existing, title: input.title, description: input.description });
      }
    }
    const row: Row = {
      id: newId(),
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority ?? 'normal',
      affectedEntityIds: input.affectedEntityIds ?? [],
      proposedActions: input.proposedActions ?? [],
      dedupeKey: input.dedupeKey ?? null,
      createdAt: nowIso(),
      readAt: null,
      resolvedAt: null,
    };
    this.db.insert(notifications).values(row).run();
    const out = toNotification(row);
    this.ctx.events.emit('notification:new', out);
    this.ctx.events.changed('notifications', 'status');
    return out;
  }

  list(opts: { includeResolved?: boolean; limit?: number; offset?: number } = {}): AppNotification[] {
    const rows = this.db
      .select()
      .from(notifications)
      .where(opts.includeResolved ? undefined : isNull(notifications.resolvedAt))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0)
      .all();
    return rows.map(toNotification);
  }

  /** The most recently resolved notifications, newest first; a snoozed one is not done and stays out until it comes back. */
  recentlyResolved(): ResolvedNotification[] {
    return this.db
      .select()
      .from(notifications)
      .where(and(isNotNull(notifications.resolvedAt), notExists(this.pendingSnooze())))
      .orderBy(desc(notifications.resolvedAt), desc(notifications.id))
      .limit(RECENTLY_RESOLVED_LIMIT)
      .all()
      .map((r) => ResolvedNotification.parse(toNotification(r)));
  }

  /** Open notifications whose dedupe key starts with the prefix. */
  openByDedupePrefix(prefix: string): AppNotification[] {
    return this.db
      .select()
      .from(notifications)
      .where(and(sql`${notifications.dedupeKey} LIKE ${`${prefix}%`}`, isNull(notifications.resolvedAt)))
      .all()
      .map(toNotification);
  }

  get(id: string): AppNotification {
    const r = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Benachrichtigung nicht gefunden.');
    return toNotification(r);
  }

  unreadCount(): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(and(isNull(notifications.readAt), isNull(notifications.resolvedAt)))
        .get()?.count ?? 0
    );
  }

  markRead(ids: string[]): void {
    const now = nowIso();
    for (const id of ids)
      this.db
        .update(notifications)
        .set({ readAt: now })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
        .run();
    this.ctx.events.changed('notifications', 'status');
  }

  /** Marks every open, unread notification as read ("Alle als gelesen markieren"); returns how many. */
  markAllRead(): number {
    const result = this.db
      .update(notifications)
      .set({ readAt: nowIso() })
      .where(and(isNull(notifications.readAt), isNull(notifications.resolvedAt)))
      .run();
    if (result.changes > 0) this.ctx.events.changed('notifications', 'status');
    return result.changes;
  }

  resolve(id: string): AppNotification {
    const now = nowIso();
    this.db
      .update(notifications)
      .set({ resolvedAt: now, readAt: sql`coalesce(${notifications.readAt}, ${now})` })
      .where(eq(notifications.id, id))
      .run();
    this.ctx.events.changed('notifications', 'status');
    return this.get(id);
  }

  /** Resolves all open notifications ("Alle leeren" in the bell). Returns how many were closed. */
  resolveAll(): number {
    const now = nowIso();
    const result = this.db
      .update(notifications)
      .set({ resolvedAt: now, readAt: sql`coalesce(${notifications.readAt}, ${now})` })
      .where(isNull(notifications.resolvedAt))
      .run();
    if (result.changes > 0) this.ctx.events.changed('notifications', 'status');
    return result.changes;
  }

  /** Resolves all open notifications with the key prefix (e.g. when the cause no longer exists). */
  resolveByDedupePrefix(prefix: string): void {
    this.db
      .update(notifications)
      .set({ resolvedAt: nowIso() })
      .where(and(sql`${notifications.dedupeKey} LIKE ${`${prefix}%`}`, isNull(notifications.resolvedAt)))
      .run();
    this.ctx.events.changed('notifications', 'status');
  }

  /** Closes open notifications of a key prefix whose cause no longer exists (not in `currentKeys`). */
  resolveStale(prefix: string, currentKeys: Set<string>): void {
    const stale = this.db
      .select({ id: notifications.id, key: notifications.dedupeKey })
      .from(notifications)
      .where(and(sql`${notifications.dedupeKey} LIKE ${`${prefix}%`}`, isNull(notifications.resolvedAt)))
      .all()
      .filter((n) => n.key !== null && !currentKeys.has(n.key));
    const now = nowIso();
    for (const n of stale) this.db.update(notifications).set({ resolvedAt: now }).where(eq(notifications.id, n.id)).run();
    if (stale.length) this.ctx.events.changed('notifications', 'status');
  }

  /** Deletes notifications that were read more than `days` days ago, except snoozed ones still waiting to come back (#79); returns how many. */
  pruneRead(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db
      .delete(notifications)
      .where(and(isNotNull(notifications.readAt), lt(notifications.readAt, cutoff), notExists(this.pendingSnooze())))
      .run().changes;
  }

  /** Correlated subquery: the notification of the outer query waits for its snooze reminder. */
  private pendingSnooze() {
    return this.db
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.targetType, 'notification'), eq(reminders.targetId, notifications.id), eq(reminders.status, 'pending')));
  }

  /** Reopens a resolved notification (after "Später erinnern") as new and unread; null if it no longer exists. */
  reopen(id: string): AppNotification | null {
    const existing = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!existing) return null;
    const reopened: Row = { ...existing, resolvedAt: null, readAt: null, createdAt: nowIso() };
    this.db
      .update(notifications)
      .set({ resolvedAt: reopened.resolvedAt, readAt: reopened.readAt, createdAt: reopened.createdAt })
      .where(eq(notifications.id, id))
      .run();
    const out = toNotification(reopened);
    this.ctx.events.emit('notification:new', out);
    this.ctx.events.changed('notifications', 'status');
    return out;
  }
}
