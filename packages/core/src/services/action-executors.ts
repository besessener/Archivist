import { ActionParamSchemas, type AgentActionType } from '@archivist/shared';
import { AppError } from '../util/errors';
import type { ActionDeps } from './actions';

type Params = Record<string, unknown>;
type Executor = (deps: ActionDeps, params: Params) => Promise<string> | string;

const TRIGGER = 'agent_action';

const takenOverNote = (takenOver: string[]) => (takenOver.length ? `; übernommen: ${takenOver.join(', ')}` : '');

async function archiveDocuments(d: ActionDeps, p: Params): Promise<string> {
  const params = ActionParamSchemas.archive_documents.parse(p);
  const result = await d.archive.execute(params.items, {
    confirmed: true,
    approveNewCategories: params.approveNewCategories,
    confirmMove: params.items.some((i) => i.mode === 'move'),
    trigger: TRIGGER,
  });
  return `${result.success} archiviert, ${result.skipped} übersprungen, ${result.failed} fehlgeschlagen, ${result.conflicts} Konflikte.`;
}

async function relocateDocuments(d: ActionDeps, p: Params): Promise<string> {
  const params = ActionParamSchemas.relocate_documents.parse(p);
  const result = await d.archive.relocate(params.items, { confirmed: true, trigger: TRIGGER });
  const summary = `${result.success} verschoben, ${result.skipped} übersprungen, ${result.failed} fehlgeschlagen, ${result.conflicts} Konflikte.`;
  // Nothing moved although something should have: the action failed (an insight behind it stays open).
  if (result.success === 0 && result.failed + result.conflicts > 0) {
    const reasons = result.items.filter((i) => i.outcome === 'failed' || i.outcome === 'conflict').map((i) => i.message);
    throw new AppError(result.failed > 0 ? 'filesystem_error' : 'archive_conflict', `Es wurde nichts verschoben: ${summary}`, {
      details: [...new Set(reasons)].join(' '),
    });
  }
  return summary;
}

const mergeNotesOrEvents =
  (type: 'merge_notes' | 'merge_events'): Executor =>
  (d, p) => {
    const params = ActionParamSchemas[type].parse(p);
    const opts = { actor: 'user' as const, trigger: TRIGGER };
    const result =
      type === 'merge_notes'
        ? d.noteEventDuplicates.mergeNotes(params.keepId, params.duplicateId, opts)
        : d.noteEventDuplicates.mergeEvents(params.keepId, params.duplicateId, opts);
    return `„${result.duplicateTitle}“ als Duplikat von „${result.keepTitle}“ verworfen${takenOverNote(result.takenOver)}.`;
  };

function createOpenItem(d: ActionDeps, p: Params): string {
  const params = ActionParamSchemas.create_open_item.parse(p);
  d.openItems.create(
    {
      title: params.title,
      description: params.description,
      dueAt: params.dueAt,
      responsible: params.responsible,
      sourceIds: params.sourceIds,
      topic: params.topic,
      project: params.project,
      priority: 'normal',
      confidence: 0.7,
    },
    { actor: 'agent', trigger: TRIGGER },
  );
  return 'Offener Punkt angelegt.';
}

function recordDecision(d: ActionDeps, p: Params): string {
  const params = ActionParamSchemas.record_decision.parse(p);
  d.decisions.create(
    {
      decisionText: params.decisionText,
      title: params.title,
      decidedAt: params.decidedAt,
      participants: params.participants,
      topic: params.topic,
      project: params.project,
      sourceIds: params.sourceIds,
      alternatives: [],
      unknownFields: [],
      asDraft: false,
      confidence: 0.7,
      origin: 'document',
      evidence: params.evidence ?? null,
    },
    { actor: 'agent', trigger: TRIGGER },
  );
  return 'Entscheidung erfasst (ggf. als Entwurf mit offenen Pflichtfeldern).';
}

/** One executor per action type: runs a confirmed proposal and returns its user-facing result. */
const EXECUTORS: Record<AgentActionType, Executor> = {
  archive_documents: archiveDocuments,
  relocate_documents: relocateDocuments,
  assign_documents: (d, p) => {
    const params = ActionParamSchemas.assign_documents.parse(p);
    for (const id of params.documentIds) d.documents.assign(id, { topic: params.topic ?? undefined, project: params.project ?? undefined, trigger: TRIGGER });
    return `${params.documentIds.length} Dokument(e) zugeordnet.`;
  },
  supersede_decision: (d, p) => {
    const params = ActionParamSchemas.supersede_decision.parse(p);
    d.decisions.supersede(params.oldDecisionId, params.newDecisionId, { confirmed: true, trigger: TRIGGER });
    return 'Ältere Entscheidung als überholt markiert.';
  },
  revoke_decision: (d, p) => {
    const params = ActionParamSchemas.revoke_decision.parse(p);
    d.decisions.revoke(params.decisionId, { confirmed: true, trigger: TRIGGER });
    return 'Entscheidung widerrufen.';
  },
  resolve_contradiction: (d, p) => {
    const params = ActionParamSchemas.resolve_contradiction.parse(p);
    d.contradictions.resolve(params.contradictionId, params.resolution, {
      confirmed: true,
      supersedeOldDecisionId: params.supersedeOldDecisionId,
      supersedeNewDecisionId: params.supersedeNewDecisionId,
    });
    return 'Widerspruch aufgelöst.';
  },
  close_open_item: (d, p) => {
    const params = ActionParamSchemas.close_open_item.parse(p);
    d.openItems.close(params.openItemId, params.status, { confirmed: true, trigger: TRIGGER, resolutionNote: params.resolutionNote });
    return 'Offener Punkt geschlossen.';
  },
  merge_topics: async (d, p) => {
    const params = ActionParamSchemas.merge_topics.parse(p);
    const result = await d.graph.merge({ sourceIds: [params.sourceTopicId], targetId: params.targetTopicId }, { trigger: TRIGGER, action: 'topics.merge' });
    return `Themen zusammengeführt (${result.relationsMoved} Beziehungen übernommen).`;
  },
  merge_entities: async (d, p) => {
    const params = ActionParamSchemas.merge_entities.parse(p);
    const result = await d.graph.merge({ sourceIds: params.sourceIds, targetId: params.targetId, allowCrossType: params.allowCrossType }, { trigger: TRIGGER });
    return `${result.mergedNames.map((n) => `„${n}“`).join(', ')} mit „${result.targetName}“ zusammengeführt (${result.relationsMoved} Beziehungen, ${result.referencesUpdated} Verweise übernommen).`;
  },
  merge_notes: mergeNotesOrEvents('merge_notes'),
  merge_events: mergeNotesOrEvents('merge_events'),
  confirm_relation: (d, p) => {
    const params = ActionParamSchemas.confirm_relation.parse(p);
    // the user's decision, undoable in the change log (#283)
    d.graph.decideRelation(params.relationId, 'confirmed', { trigger: TRIGGER });
    return 'Beziehung bestätigt.';
  },
  link_entities: (d, p) => {
    const params = ActionParamSchemas.link_entities.parse(p);
    d.graph.linkEntries(params.sourceId, params.targetId, params.relationType, { status: 'confirmed', trigger: TRIGGER });
    const source = d.graph.getEntity(params.sourceId)?.name ?? params.sourceId;
    const target = d.graph.getEntity(params.targetId)?.name ?? params.targetId;
    return `„${source}“ mit „${target}“ verknüpft.`;
  },
  reject_relation: (d, p) => {
    const params = ActionParamSchemas.reject_relation.parse(p);
    d.graph.setRelationStatus(params.relationId, 'rejected');
    d.audit.log({ action: 'relation.reject', actor: 'user', trigger: TRIGGER, confirmed: true, entityIds: [params.relationId] });
    return 'Beziehung abgelehnt.';
  },
  exclude_path: (d, p) => {
    const params = ActionParamSchemas.exclude_path.parse(p);
    d.scanner.exclude(params.kind, params.path);
    return 'Von künftigen Scans ausgeschlossen.';
  },
  create_category: (d, p) => {
    const params = ActionParamSchemas.create_category.parse(p);
    d.archive.createCategory(params.path, true);
    return 'Kategorie angelegt.';
  },
  set_reminder: (d, p) => {
    const params = ActionParamSchemas.set_reminder.parse(p);
    d.reminders.create({ targetType: params.targetType as 'custom', targetId: params.targetId, title: params.title, remindAt: params.remindAt });
    return 'Erinnerung angelegt.';
  },
  create_open_item: createOpenItem,
  add_open_item_source: (d, p) => {
    const { openItemId, documentId, ...extra } = ActionParamSchemas.add_open_item_source.parse(p);
    d.openItems.addSource(openItemId, documentId, extra, { actor: 'agent', trigger: TRIGGER });
    return 'Offener Punkt um Quelle ergänzt.';
  },
  merge_open_items: (d, p) => {
    const params = ActionParamSchemas.merge_open_items.parse(p);
    const result = d.openItemDuplicates.merge(params.keepId, params.duplicateId, { trigger: TRIGGER });
    return `„${result.duplicate.title}“ als Duplikat von „${result.keep.title}“ verworfen${takenOverNote(result.takenOver)}.`;
  },
  undo_change: async (d, p) => {
    const params = ActionParamSchemas.undo_change.parse(p);
    const result = await d.undo.undo(params.auditId);
    if (!result.undone) throw new AppError('validation_error', result.message, { details: result.conflicts.join(' ') || undefined });
    return result.message;
  },
  agent_batch: (d, p) => {
    const params = ActionParamSchemas.agent_batch.parse(p);
    if (!d.agentBatch) throw new AppError('validation_error', 'Der Agentenmodus ist nicht verfügbar.');
    return d.agentBatch(params);
  },
  record_decision: recordDecision,
};

/** Executes a confirmed proposal; only `ActionService.resolve` may call this. */
export async function executeAction(deps: ActionDeps, action: { type: AgentActionType; params: Params }): Promise<string> {
  return EXECUTORS[action.type](deps, action.params);
}
