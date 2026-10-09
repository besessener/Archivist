import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { openItems, reminders } from '../db/schema';
import { AppError } from '../util/errors';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { OpenItemDeleteUndo } from './open-item-undo';
import { OPEN_ITEM_DELETE_UNDO_TYPE } from './open-item-undo';
import type { SearchService } from './search';

export interface OpenItemDeleteDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  search: SearchService;
  audit: AuditService;
}

/** Stage 2: deletes an open item with its reminders, graph node and search entry; the audit entry carries everything the undo restores. */
export function deleteOpenItem({ ctx, graph, search, audit }: OpenItemDeleteDeps, { id, confirmed }: { id: string; confirmed: boolean }): void {
  if (!confirmed) throw new AppError('permission_error', 'Das Löschen eines offenen Punkts erfordert eine ausdrückliche Bestätigung.');
  const db = ctx.database.db;
  const item = db.select().from(openItems).where(eq(openItems.id, id)).get();
  if (!item) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
  const ownReminders = and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, id));
  const undoData: OpenItemDeleteUndo = { item, node: graph.snapshotNode(id), reminders: db.select().from(reminders).where(ownReminders).all() };
  db.transaction(() => {
    db.delete(reminders).where(ownReminders).run();
    db.delete(openItems).where(eq(openItems.id, id)).run();
    graph.removeNode(id);
    audit.log({
      action: 'open_item.delete',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: item.title, status: item.status, dueAt: item.dueAt },
      undo: { type: OPEN_ITEM_DELETE_UNDO_TYPE, data: undoData },
    });
    // last: the in-memory vector index does not roll back with the transaction
    search.remove(id);
  });
  ctx.events.changed('openItems', 'knowledge', 'status', 'reminders');
}
