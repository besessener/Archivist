import { ActionParamSchemas, type AgentActionType } from '@archivist/shared';
import type { ActionDeps } from './actions';
import { folderOf } from './archive-structure';
import { ACTIVE_DECISION_STATUSES } from './decisions';

type Params = Record<string, unknown>;
export type Revalidation = { params: Params } | { stale: string };
type Revalidator = (deps: ActionDeps, params: Params) => Revalidation;

/** Entity ids named by a merge proposal (sources and target). */
export function mergedIds(type: 'merge_entities' | 'merge_topics', params: Params): string[] {
  if (type === 'merge_topics') {
    const p = ActionParamSchemas.merge_topics.parse(params);
    return [p.sourceTopicId, p.targetTopicId];
  }
  const p = ActionParamSchemas.merge_entities.parse(params);
  return [...p.sourceIds, p.targetId];
}

const unlessStale = (stale: string | null, params: Params): Revalidation => (stale ? { stale } : { params });

function relocation(deps: ActionDeps, params: Params): Revalidation {
  const p = ActionParamSchemas.relocate_documents.parse(params);
  const items: Array<{ documentId: string; categoryPath: string }> = [];
  for (const item of p.items) {
    const row = deps.documents.getRow(item.documentId);
    if (row.status !== 'archived' || !row.archiveRelPath) return { stale: `„${row.title}“ ist nicht mehr archiviert.` };
    if (item.fromRelPath !== undefined && row.archiveRelPath !== item.fromRelPath)
      return { stale: `„${row.title}“ wurde inzwischen an einen anderen Ort verschoben.` };
    if (folderOf(row) !== item.categoryPath.split('/').filter(Boolean).join('/')) items.push({ documentId: item.documentId, categoryPath: item.categoryPath });
  }
  if (items.length === 0) return { stale: 'Die Dokumente liegen bereits im Zielordner.' };
  return { params: { items } };
}

function supersession(deps: ActionDeps, params: Params): Revalidation {
  const p = ActionParamSchemas.supersede_decision.parse(params);
  const older = deps.decisions.get(p.oldDecisionId);
  const newer = deps.decisions.get(p.newDecisionId);
  if (older.status === 'superseded' && newer.supersedesDecisionId === older.id) return { params }; // already done: no-op
  if (!ACTIVE_DECISION_STATUSES.includes(older.status) || !ACTIVE_DECISION_STATUSES.includes(newer.status))
    return { stale: 'Eine der beiden Entscheidungen ist inzwischen nicht mehr aktiv.' };
  return { params };
}

function contradiction(deps: ActionDeps, params: Params): Revalidation {
  const p = ActionParamSchemas.resolve_contradiction.parse(params);
  const c = deps.contradictions.get(p.contradictionId);
  if (c.status === 'resolved' || c.status === 'false_positive') return { stale: 'Der Widerspruch ist bereits aufgelöst.' };
  return { params };
}

const merge =
  (type: 'merge_entities' | 'merge_topics'): Revalidator =>
  (deps, params) =>
    mergedIds(type, params).some((id) => !deps.graph.getEntity(id))
      ? { stale: 'Einer der Einträge wurde inzwischen zusammengeführt oder gelöscht.' }
      : { params };

const noteOrEventMerge =
  (type: 'merge_notes' | 'merge_events'): Revalidator =>
  (deps, params) => {
    const p = ActionParamSchemas[type].parse(params);
    return unlessStale(deps.noteEventDuplicates.staleReason(type === 'merge_notes' ? 'note' : 'event', p.keepId, p.duplicateId), params);
  };

const REVALIDATORS: Partial<Record<AgentActionType, Revalidator>> = {
  relocate_documents: relocation,
  supersede_decision: supersession,
  resolve_contradiction: contradiction,
  merge_entities: merge('merge_entities'),
  merge_topics: merge('merge_topics'),
  undo_change: (deps, params) => {
    const p = ActionParamSchemas.undo_change.parse(params);
    return deps.audit.getRow(p.auditId).undoneAt ? { stale: 'Die Änderung wurde bereits rückgängig gemacht.' } : { params };
  },
  merge_open_items: (deps, params) => {
    const p = ActionParamSchemas.merge_open_items.parse(params);
    return unlessStale(deps.openItemDuplicates.staleReason(p.keepId, p.duplicateId), params);
  },
  merge_notes: noteOrEventMerge('merge_notes'),
  merge_events: noteOrEventMerge('merge_events'),
};

/** Re-checks a proposal right before execution: the parameters to run (possibly reduced) or why it is outdated. */
export function revalidate(deps: ActionDeps, action: { type: AgentActionType; params: Params }): Revalidation {
  const check = REVALIDATORS[action.type];
  return check ? check(deps, action.params) : { params: action.params };
}
