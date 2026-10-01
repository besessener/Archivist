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
  /** Verhindert Duplikate: gleiche (nicht erledigte) Benachrichtigung wird nur aktualisiert. */
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

/** In-App-Benachrichtigungen (Notification Bell). Desktop-Benachrichtigungen übernimmt die Host-Schicht. */
export class NotificationService {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  create(input: NotificationInput): AppNotification {
    if (input.dedupeKey) {
      const existing = this.db.select().from(notifications).where(and(eq(notifications.dedupeKey, input.dedupeKey))).get();
      if (existing) {
        if (existing.resolvedAt) return map(existing); // erledigte Hinweise nicht wiederbeleben
        this.db
          .update(notifications)
          .set({ title: input.title, description: input.description, proposedActions: (input.proposedActions ?? []), affectedEntityIds: input.affectedEntityIds ?? [], priority: input.priority ?? 'normal' })
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
      proposedActions: (input.proposedActions ?? []),
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
    return this.db.select({ c: sql<number>`count(*)` }).from(notifications).where(and(isNull(notifications.readAt), isNull(notifications.resolvedAt))).get()?.c ?? 0;
  }

  markRead(ids: string[]): void {
    const now = nowIso();
    for (const id of ids) this.db.update(notifications).set({ readAt: now }).where(and(eq(notifications.id, id), isNull(notifications.readAt))).run();
    this.ctx.events.changed('notifications', 'status');
  }

  resolve(id: string): AppNotification {
    const now = nowIso();
    this.db.update(notifications).set({ resolvedAt: now, readAt: sql`coalesce(${notifications.readAt}, ${now})` }).where(eq(notifications.id, id)).run();
    this.ctx.events.changed('notifications', 'status');
    return this.get(id);
  }

  /** Löst alle offenen Benachrichtigungen mit dem Schlüssel-Präfix auf (z. B. wenn die Ursache entfallen ist). */
  resolveByDedupePrefix(prefix: string): void {
    this.db
      .update(notifications)
      .set({ resolvedAt: nowIso() })
      .where(and(sql`${notifications.dedupeKey} LIKE ${`${prefix}%`}`, isNull(notifications.resolvedAt)))
      .run();
    this.ctx.events.changed('notifications', 'status');
  }

  /** Reaktiviert eine erledigte Benachrichtigung (nach „Später erinnern“). */
  reopen(id: string): void {
    this.db.update(notifications).set({ resolvedAt: null, readAt: null, createdAt: nowIso() }).where(eq(notifications.id, id)).run();
    this.ctx.events.changed('notifications', 'status');
  }
}
