import type { OpenItemStatus } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { openItems, reminders } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { AuditService } from './audit';
import { OPEN_ITEM_STATUS_UNDO_TYPE, type OpenItemStatusUndo } from './open-item-undo';
import { syncReminderAt } from './reminders';

export interface OpenItemCloseDeps {
  ctx: AppContext;
  audit: AuditService;
}

export interface OpenItemClosing {
  status: 'resolved' | 'dismissed';
  confirmed: boolean;
  trigger?: string;
  /** How it was solved or why it was dropped. */
  resolutionNote?: string | null;
}

/** Stage 2: closes an open item only with explicit confirmation; its open reminders end with it, and the undo entry restores both. */
export function closeOpenItem({ ctx, audit }: OpenItemCloseDeps, { id, status, ...opts }: OpenItemClosing & { id: string }): void {
  if (!opts.confirmed) throw new AppError('permission_error', 'Das Schließen eines offenen Punkts erfordert eine ausdrückliche Bestätigung.');
  const db = ctx.database.db;
  const current = db.select().from(openItems).where(eq(openItems.id, id)).get();
  if (!current) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
  const updatedAt = nowIso();
  const resolutionNote = opts.resolutionNote?.trim() || null;
  const ended = db
    .select({ id: reminders.id, status: reminders.status })
    .from(reminders)
    .where(and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, id), inArray(reminders.status, ['pending', 'fired'])))
    .all();
  db.transaction(() => {
    db.update(openItems).set({ status, updatedAt, resolutionNote }).where(eq(openItems.id, id)).run();
    for (const reminder of ended) db.update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, reminder.id)).run();
    syncReminderAt(db, id);
  });
  const undoData: OpenItemStatusUndo = {
    id,
    previousStatus: current.status as OpenItemStatus,
    previousNote: current.resolutionNote,
    afterUpdatedAt: updatedAt,
    reminders: ended,
  };
  audit.log({
    action: 'open_item.close',
    actor: 'user',
    trigger: opts.trigger ?? 'manual',
    confirmed: true,
    entityIds: [id],
    before: { status: current.status },
    after: { status, resolutionNote },
    undo: { type: OPEN_ITEM_STATUS_UNDO_TYPE, data: undoData },
  });
  ctx.events.changed('openItems', 'status', 'reminders');
}
