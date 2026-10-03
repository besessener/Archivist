import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions } from '../db/schema';
import { nowIso } from '../util/ids';
import type { DecisionRow } from './decision-fields';
import type { KnowledgeGraphService, RelationChangeSet } from './knowledge-graph';
import type { UndoService } from './undo';

export const DECISION_STATUS_UNDO_TYPE = 'decision_status';
export const DECISION_UPDATE_UNDO_TYPE = 'decision_update';

export interface DecisionUpdateUndo {
  id: string;
  /** Previous values of the edited columns. */
  before: Partial<DecisionRow>;
  afterUpdatedAt: string;
  relations: RelationChangeSet;
}

export interface DecisionStatusUndo {
  changes: Array<{ id: string; status: DecisionRow['status']; supersedesDecisionId: string | null; afterUpdatedAt: string }>;
  /** Relation changes of the action (absent in undo data written by older versions). */
  relations?: RelationChangeSet;
  /** Older undo data: ids of the relations the action linked, including ones that existed before. */
  relationIds?: string[];
}

interface DecisionUndoDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  reindex: (id: string) => Promise<void>;
  /** Called with the decisions whose status an undo restored. */
  statusUndone: (decisionIds: string[]) => void;
}

function statusConflicts({ ctx, graph }: DecisionUndoDeps, undoData: DecisionStatusUndo): string[] {
  const conflicts: string[] = [];
  for (const change of undoData.changes) {
    const row = ctx.database.db.select().from(decisions).where(eq(decisions.id, change.id)).get();
    if (!row) conflicts.push(`Entscheidung ${change.id} existiert nicht mehr.`);
    else if (row.updatedAt !== change.afterUpdatedAt) conflicts.push(`Entscheidung „${row.title}“ wurde seit der Aktion verändert.`);
  }
  return [...conflicts, ...graph.relationChangeConflicts(undoData.relations)];
}

function undoStatus({ ctx, graph, reindex, statusUndone }: DecisionUndoDeps, undoData: DecisionStatusUndo): string {
  const db = ctx.database.db;
  db.transaction(() => {
    for (const change of undoData.changes)
      db.update(decisions)
        .set({ status: change.status, supersedesDecisionId: change.supersedesDecisionId, updatedAt: nowIso() })
        .where(eq(decisions.id, change.id))
        .run();
    if (undoData.relations) graph.revertRelationChanges(undoData.relations);
    // undo data written before relation tracking existed only lists the linked relations
    else for (const relationId of undoData.relationIds ?? []) graph.deleteRelation(relationId);
  });
  for (const change of undoData.changes) void reindex(change.id);
  statusUndone(undoData.changes.map((change) => change.id));
  ctx.events.changed('decisions', 'knowledge');
  return 'Status der Entscheidung(en) wiederhergestellt.';
}

function updateConflicts({ ctx, graph }: DecisionUndoDeps, undoData: DecisionUpdateUndo): string[] {
  const row = ctx.database.db.select().from(decisions).where(eq(decisions.id, undoData.id)).get();
  if (!row) return ['Die Entscheidung existiert nicht mehr.'];
  const conflicts = row.updatedAt === undoData.afterUpdatedAt ? [] : [`Entscheidung „${row.title}“ wurde seit der Bearbeitung verändert.`];
  return [...conflicts, ...graph.relationChangeConflicts(undoData.relations)];
}

function undoUpdate({ ctx, graph, reindex }: DecisionUndoDeps, undoData: DecisionUpdateUndo): string {
  const db = ctx.database.db;
  db.transaction(() => {
    db.update(decisions)
      .set({ ...undoData.before, updatedAt: nowIso() })
      .where(eq(decisions.id, undoData.id))
      .run();
    const row = db.select().from(decisions).where(eq(decisions.id, undoData.id)).get();
    if (row) graph.registerNode({ type: 'decision', id: row.id, name: row.title, description: row.decisionText });
    graph.revertRelationChanges(undoData.relations);
  });
  void reindex(undoData.id);
  ctx.events.changed('decisions', 'knowledge', 'status');
  return 'Bearbeitung der Entscheidung rückgängig gemacht.';
}

/** Registers the undo handlers of decision status changes (supersede, revoke) and edits. */
export function registerDecisionUndo(undo: UndoService, deps: DecisionUndoDeps): void {
  undo.register(DECISION_STATUS_UNDO_TYPE, {
    check: async (data) => statusConflicts(deps, data as DecisionStatusUndo),
    run: async (data) => undoStatus(deps, data as DecisionStatusUndo),
  });
  undo.register(DECISION_UPDATE_UNDO_TYPE, {
    check: async (data) => updateConflicts(deps, data as DecisionUpdateUndo),
    run: async (data) => undoUpdate(deps, data as DecisionUpdateUndo),
  });
}
