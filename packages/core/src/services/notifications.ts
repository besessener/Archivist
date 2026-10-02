import type { AppNotification, NotificationType } from '@archivist/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { notifications } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';

type Row = typeof notifications.$inferSelect;

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

const map = (r: Row): AppNotification => ({
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

  create(input: NotificationInput): AppNotification {
    if (input.dedupeKey) {
      const existing = this.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.dedupeKey, input.dedupeKey)))
        .get();
      if (existing) {
        if (existing.resolvedAt) return map(existing); // do not revive resolved notifications
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
        return map({ ...existing, title: input.title, description: input.description });
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
    const out = map(row);
    this.ctx.events.emit('notification:new', out);
    this.ctx.events.changed('notifications', 'status');
    return out;
  }

  list(opts: { includeResolved?: boolean; limit?: number } = {}): AppNotification[] {
    const rows = this.db
      .select()
      .from(notifications)
      .where(opts.includeResolved ? undefined : isNull(notifications.resolvedAt))
      .orderBy(desc(notifications.createdAt))
      .limit(opts.limit ?? 100)
      .all();
    return rows.map(map);
  }

  get(id: string): AppNotification {
    const r = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Benachrichtigung nicht gefunden.');
    return map(r);
  }

  unreadCount(): number {
    return (
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(notifications)
        .where(and(isNull(notifications.readAt), isNull(notifications.resolvedAt)))
        .get()?.c ?? 0
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

  /**
   * Reopens a resolved notification (after "Später erinnern"): title, actions and targets stay unchanged,
   * it moves to the top as unread and is announced again like a new notification. Returns null if it no longer exists.
   */
  reopen(id: string): AppNotification | null {
    const existing = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!existing) return null;
    const reopened: Row = { ...existing, resolvedAt: null, readAt: null, createdAt: nowIso() };
    this.db
      .update(notifications)
      .set({ resolvedAt: reopened.resolvedAt, readAt: reopened.readAt, createdAt: reopened.createdAt })
      .where(eq(notifications.id, id))
      .run();
    const out = map(reopened);
    this.ctx.events.emit('notification:new', out);
    this.ctx.events.changed('notifications', 'status');
    return out;
  }
}
