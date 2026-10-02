import type { OpenItemStatus } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { openItems, reminders } from '../db/schema';
import { nowIso } from '../util/ids';
import type { KnowledgeGraphService, RelationChangeSet } from './knowledge-graph';
import type { OpenItemRow } from './open-item-fields';
import { syncReminderAt } from './reminders';
import type { UndoService } from './undo';

export const OPEN_ITEM_STATUS_UNDO_TYPE = 'open_item_status';
export const OPEN_ITEM_UPDATE_UNDO_TYPE = 'open_item_update';

export interface OpenItemUpdateUndo {
  id: string;
  /** Previous values of the edited columns. */
  before: Partial<OpenItemRow>;
  afterUpdatedAt: string;
  relations: RelationChangeSet;
}

export interface OpenItemStatusUndo {
  id: string;
  previousStatus: OpenItemStatus;
  previousNote?: string | null;
  afterUpdatedAt: string;
  /** Reminders ended on closing; undo brings them back. */
  reminders?: Array<{ id: string; status: string }>;
}

interface OpenItemUndoDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  reindex: (id: string) => Promise<void>;
}

const GONE = 'Der offene Punkt existiert nicht mehr.';

const updatedAtOf = (ctx: AppContext, id: string) => ctx.database.db.select().from(openItems).where(eq(openItems.id, id)).get()?.updatedAt;

function statusConflicts(ctx: AppContext, undoData: OpenItemStatusUndo): string[] {
  const updatedAt = updatedAtOf(ctx, undoData.id);
  if (updatedAt === undefined) return [GONE];
  return updatedAt === undoData.afterUpdatedAt ? [] : ['Der offene Punkt wurde seit der Aktion verändert.'];
}

function updateConflicts({ ctx, graph }: OpenItemUndoDeps, undoData: OpenItemUpdateUndo): string[] {
  const updatedAt = updatedAtOf(ctx, undoData.id);
  if (updatedAt === undefined) return [GONE];
  const conflicts = updatedAt === undoData.afterUpdatedAt ? [] : ['Der offene Punkt wurde seit der Bearbeitung verändert.'];
  return [...conflicts, ...graph.relationChangeConflicts(undoData.relations)];
}

function undoStatus(ctx: AppContext, undoData: OpenItemStatusUndo): string {
  const db = ctx.database.db;
  db.transaction(() => {
    db.update(openItems)
      .set({ status: undoData.previousStatus, resolutionNote: undoData.previousNote ?? null, updatedAt: nowIso() })
      .where(eq(openItems.id, undoData.id))
      .run();
    for (const reminder of undoData.reminders ?? []) db.update(reminders).set({ status: reminder.status }).where(eq(reminders.id, reminder.id)).run();
    syncReminderAt(db, undoData.id);
  });
  ctx.events.changed('openItems', 'reminders');
  return 'Status des offenen Punkts wiederhergestellt.';
}

function undoUpdate({ ctx, graph, reindex }: OpenItemUndoDeps, undoData: OpenItemUpdateUndo): string {
  const db = ctx.database.db;
  db.transaction(() => {
    db.update(openItems)
      .set({ ...undoData.before, updatedAt: nowIso() })
      .where(eq(openItems.id, undoData.id))
      .run();
    const row = db.select().from(openItems).where(eq(openItems.id, undoData.id)).get();
    if (row) graph.registerNode('task', row.id, row.title, row.description);
    graph.revertRelationChanges(undoData.relations);
  });
  void reindex(undoData.id);
  ctx.events.changed('openItems', 'knowledge', 'status');
  return 'Bearbeitung des offenen Punkts rückgängig gemacht.';
}

/** Registers the undo handlers of closing and editing an open item. */
export function registerOpenItemUndo(undo: UndoService, deps: OpenItemUndoDeps): void {
  undo.register(OPEN_ITEM_STATUS_UNDO_TYPE, {
    check: async (data) => statusConflicts(deps.ctx, data as OpenItemStatusUndo),
    run: async (data) => undoStatus(deps.ctx, data as OpenItemStatusUndo),
  });
  undo.register(OPEN_ITEM_UPDATE_UNDO_TYPE, {
    check: async (data) => updateConflicts(deps, data as OpenItemUpdateUndo),
    run: async (data) => undoUpdate(deps, data as OpenItemUpdateUndo),
  });
}
