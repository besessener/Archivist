import type { z } from 'zod';
import {
  ActionParamSchemas,
  type AgentActionProposal,
  type AgentActionStatus,
  type AgentActionType,
  type EntityRef,
  type StoredAgentAction,
} from '@archivist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentActions } from '../db/schema';
import { AppError, toErrorInfo } from '../util/errors';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import type { ArchiveService } from './archive';
import { folderOf } from './archive-structure';
import type { AuditService } from './audit';
import type { NoteEventDuplicateService } from './cleanup/note-event-duplicates';
import type { OpenItemDuplicateService } from './cleanup/open-item-duplicates';
import type { ContradictionService } from './contradictions';
import type { DecisionService } from './decisions';
import { ACTIVE_DECISION_STATUSES } from './decisions';
import type { DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { OpenItemService } from './open-items';
import type { ReminderService } from './reminders';
import type { ScannerService } from './scanner';
import type { UndoService } from './undo';

type Row = typeof agentActions.$inferSelect;

const map = (r: Row): StoredAgentAction => ({
  id: r.id,
  conversationId: r.conversationId,
  actionType: r.actionType as AgentActionType,
  label: r.label,
  rationale: r.rationale,
  confidence: r.confidence,
  affectedEntities: r.affectedEntities as EntityRef[],
  requiredConfirmation: r.requiredConfirmation as StoredAgentAction['requiredConfirmation'],
  proposedParameters: r.params as Record<string, unknown>,
  status: r.status as AgentActionStatus,
  result: r.result,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

/** Entity ids named by a merge proposal (sources and target). */
function mergedIds(type: 'merge_entities' | 'merge_topics', params: Record<string, unknown>): string[] {
  if (type === 'merge_topics') {
    const p = ActionParamSchemas.merge_topics.parse(params);
    return [p.sourceTopicId, p.targetTopicId];
  }
  const p = ActionParamSchemas.merge_entities.parse(params);
  return [...p.sourceIds, p.targetId];
}

/** Executes a confirmed proposal card of an agent run (provided by the agent service, #298). */
export type AgentBatchExecutor = (params: z.output<(typeof ActionParamSchemas)['agent_batch']>) => Promise<string>;

export interface ActionDeps {
  archive: ArchiveService;
  documents: DocumentService;
  decisions: DecisionService;
  openItems: OpenItemService;
  openItemDuplicates: OpenItemDuplicateService;
  contradictions: ContradictionService;
  graph: KnowledgeGraphService;
  noteEventDuplicates: NoteEventDuplicateService;
  scanner: ScannerService;
  reminders: ReminderService;
  audit: AuditService;
  undo: UndoService;
  agentBatch?: AgentBatchExecutor;
}

/** From this many documents a relocation counts as especially far-reaching („besonders folgenreich“). */
const STRONG_RELOCATION_DOCUMENTS = 20;

/**
 * Agent actions: the agent only creates proposals (`propose`). Execution happens exclusively through `resolve`
 * after the user's decision. Parameters are validated with Zod per action type.
 */
export class ActionService {
  private deps!: ActionDeps;
  private readonly withdrawnListeners: Array<(action: StoredAgentAction) => void> = [];

  constructor(private readonly ctx: AppContext) {}

  wire(deps: ActionDeps): void {
    this.deps = deps;
  }

  setAgentBatchExecutor(fn: AgentBatchExecutor): void {
    this.deps.agentBatch = fn;
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Called whenever a proposal is withdrawn (e.g. so that the insight recommending it disappears as well). */
  onWithdrawn(listener: (action: StoredAgentAction) => void): void {
    this.withdrawnListeners.push(listener);
  }

  /** Validated parameters of a proposal, in the shape they are stored with. */
  normalizeParams(actionType: AgentActionType, params: Record<string, unknown>): Record<string, unknown> {
    const parsed = ActionParamSchemas[actionType].safeParse(params);
    if (!parsed.success) {
      throw new AppError('validation_error', 'Die vorgeschlagene Aktion hat ungültige Parameter und wurde verworfen.', {
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    return parsed.data;
  }

  propose(input: AgentActionProposal & { label: string; conversationId?: string | null }): StoredAgentAction {
    const params = this.normalizeParams(input.actionType, input.proposedParameters);
    // moving many archived documents at once is especially far-reaching: it needs the explicit confirmation
    // dialog, a typed „ja“ in the chat is not enough (#199)
    const items = input.actionType === 'relocate_documents' ? ((params.items as unknown[] | undefined)?.length ?? 0) : 0;
    const requiredConfirmation = items >= STRONG_RELOCATION_DOCUMENTS ? 'strong' : input.requiredConfirmation;
    const row: Row = {
      id: newId(),
      conversationId: input.conversationId ?? null,
      actionType: input.actionType,
      label: input.label,
      rationale: input.rationale,
      confidence: input.confidence,
      affectedEntities: input.affectedEntities,
      requiredConfirmation,
      params: params as ArchivistJson,
      status: 'proposed',
      result: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.db.insert(agentActions).values(row).run();
    this.ctx.events.changed('status');
    return map(row);
  }

  get(id: string): StoredAgentAction {
    const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Aktion nicht gefunden.');
    return map(r);
  }

  getMany(ids: string[]): StoredAgentAction[] {
    return ids.flatMap((id) => {
      const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
      return r ? [map(r)] : [];
    });
  }

  list(status?: StoredAgentAction['status']): StoredAgentAction[] {
    return this.db
      .select()
      .from(agentActions)
      .where(status ? eq(agentActions.status, status) : undefined)
      .orderBy(desc(agentActions.createdAt))
      .limit(200)
      .all()
      .map(map);
  }

  /**
   * Open proposals that were shown as a card in this conversation and originated there – in the order
   * they were shown. Proposals from other sources (archive check, insights, other conversations) are never included.
   */
  openInConversation(conversationId: string, shownActionIds: string[]): StoredAgentAction[] {
    return this.getMany([...new Set(shownActionIds)]).filter((a) => a.status === 'proposed' && a.conversationId === conversationId);
  }

  /**
   * Retracts an undecided proposal without executing it (status `withdrawn`), e.g. because its cause is gone or a newer
   * proposal replaces it. Returns false if the proposal was already decided.
   */
  withdraw(id: string, reason: string): boolean {
    const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
    if (!r || r.status !== 'proposed') return false;
    this.db.update(agentActions).set({ status: 'withdrawn', result: reason, resolvedAt: nowIso() }).where(eq(agentActions.id, id)).run();
    const withdrawn = this.get(id);
    for (const listener of this.withdrawnListeners) listener(withdrawn);
    this.ctx.events.changed('status', 'insights');
    return true;
  }

  /** Open relocate proposals that would move at least one of these documents. */
  openRelocationsFor(documentIds: Iterable<string>): StoredAgentAction[] {
    const ids = new Set(documentIds);
    return this.list('proposed').filter(
      (a) =>
        a.actionType === 'relocate_documents' && ActionParamSchemas.relocate_documents.parse(a.proposedParameters).items.some((i) => ids.has(i.documentId)),
    );
  }

  /** A fresh, undecided copy of a failed or rejected proposal, so that it can be decided (and executed) again. */
  repropose(id: string): StoredAgentAction {
    const a = this.get(id);
    return this.propose({
      actionType: a.actionType,
      label: a.label,
      rationale: a.rationale,
      confidence: a.confidence,
      affectedEntities: a.affectedEntities,
      requiredConfirmation: a.requiredConfirmation,
      proposedParameters: a.proposedParameters,
      conversationId: a.conversationId,
    });
  }

  async resolve(
    id: string,
    decision: 'approve' | 'reject',
    opts: { confirmed?: boolean; strongConfirmed?: boolean; overrides?: Record<string, unknown> },
  ): Promise<StoredAgentAction> {
    const action = this.get(id);
    if (action.status !== 'proposed') return action;
    const now = nowIso();
    if (decision === 'reject') {
      this.db.update(agentActions).set({ status: 'rejected', resolvedAt: now }).where(eq(agentActions.id, id)).run();
      // a relation card has confirm and reject: rejecting discards the proposed relation
      if (action.actionType === 'confirm_relation') {
        const params = ActionParamSchemas.confirm_relation.parse(action.proposedParameters);
        this.deps.graph.setRelationStatus(params.relationId, 'rejected');
        this.deps.audit.log({ action: 'relation.reject', actor: 'user', trigger: 'confirmation', confirmed: true, entityIds: [params.relationId] });
      }
      this.deps.audit.log({
        action: `action.reject:${action.actionType}`,
        actor: 'user',
        trigger: 'confirmation',
        confirmed: true,
        entityIds: action.affectedEntities.map((e) => e.id),
      });
      this.ctx.events.changed('status', 'insights');
      return this.get(id);
    }
    if (!opts.confirmed) throw new AppError('permission_error', 'Diese Aktion erfordert eine ausdrückliche Bestätigung.');
    if (action.requiredConfirmation === 'strong' && !opts.strongConfirmed) {
      throw new AppError('permission_error', 'Diese Aktion ist besonders kritisch und erfordert eine zweite, ausdrückliche Bestätigung.');
    }
    const parsed = ActionParamSchemas[action.actionType].safeParse({ ...action.proposedParameters, ...(opts.overrides ?? {}) });
    let params: Record<string, unknown> | null = parsed.success ? parsed.data : null; // invalid parameters fail below
    if (params) {
      let stale: string | null;
      try {
        const checked = this.revalidate(action.actionType, params);
        stale = 'stale' in checked ? checked.stale : null;
        if ('params' in checked) params = checked.params;
      } catch (err) {
        stale = toErrorInfo(err).message;
      }
      if (stale !== null) {
        // the world changed since the proposal: never execute outdated parameters (e.g. move a document back)
        this.withdraw(id, `Nicht ausgeführt, der Vorschlag ist nicht mehr aktuell: ${stale}`);
        return this.get(id);
      }
    }
    this.db.update(agentActions).set({ status: 'approved' }).where(eq(agentActions.id, id)).run();
    let executed: Record<string, unknown> | null = null;
    try {
      const run = params ?? ActionParamSchemas[action.actionType].parse({ ...action.proposedParameters, ...(opts.overrides ?? {}) });
      const result = await this.execute(action.actionType, run as never);
      this.db.update(agentActions).set({ status: 'executed', result, resolvedAt: nowIso() }).where(eq(agentActions.id, id)).run();
      executed = run;
    } catch (err) {
      const info = toErrorInfo(err);
      this.ctx.logger.error('actions', `Action failed: ${action.actionType}`, { error: err });
      this.db
        .update(agentActions)
        .set({ status: 'failed', result: info.message + (info.details ? ` (${info.details})` : ''), resolvedAt: nowIso() })
        .where(eq(agentActions.id, id))
        .run();
    }
    if (executed) {
      try {
        this.afterExecuted(id, action.actionType, executed);
      } catch (err) {
        this.ctx.logger.warn('actions', 'Could not withdraw outdated proposals', { error: err });
      }
    }
    this.ctx.events.changed('status', 'insights', 'notifications');
    return this.get(id);
  }

  /**
   * Re-checks a proposal against the current state right before it is executed. Returns the parameters to execute
   * (possibly reduced) or why the proposal is outdated.
   */
  private revalidate(type: AgentActionType, params: Record<string, unknown>): { params: Record<string, unknown> } | { stale: string } {
    const d = this.deps;
    switch (type) {
      case 'relocate_documents': {
        const p = ActionParamSchemas.relocate_documents.parse(params);
        const items: Array<{ documentId: string; categoryPath: string }> = [];
        for (const item of p.items) {
          const row = d.documents.getRow(item.documentId);
          if (row.status !== 'archived' || !row.archiveRelPath) return { stale: `„${row.title}“ ist nicht mehr archiviert.` };
          if (item.fromRelPath !== undefined && row.archiveRelPath !== item.fromRelPath)
            return { stale: `„${row.title}“ wurde inzwischen an einen anderen Ort verschoben.` };
          if (folderOf(row) !== item.categoryPath.split('/').filter(Boolean).join('/'))
            items.push({ documentId: item.documentId, categoryPath: item.categoryPath });
        }
        if (items.length === 0) return { stale: 'Die Dokumente liegen bereits im Zielordner.' };
        return { params: { items } };
      }
      case 'supersede_decision': {
        const p = ActionParamSchemas.supersede_decision.parse(params);
        const older = d.decisions.get(p.oldDecisionId);
        const newer = d.decisions.get(p.newDecisionId);
        if (older.status === 'superseded' && newer.supersedesDecisionId === older.id) return { params }; // already done: no-op
        if (!ACTIVE_DECISION_STATUSES.includes(older.status) || !ACTIVE_DECISION_STATUSES.includes(newer.status))
          return { stale: 'Eine der beiden Entscheidungen ist inzwischen nicht mehr aktiv.' };
        return { params };
      }
      case 'resolve_contradiction': {
        const p = ActionParamSchemas.resolve_contradiction.parse(params);
        const c = d.contradictions.get(p.contradictionId);
        if (c.status === 'resolved' || c.status === 'false_positive') return { stale: 'Der Widerspruch ist bereits aufgelöst.' };
        return { params };
      }
      case 'merge_entities':
      case 'merge_topics': {
        if (mergedIds(type, params).some((id) => !d.graph.getEntity(id)))
          return { stale: 'Einer der Einträge wurde inzwischen zusammengeführt oder gelöscht.' };
        return { params };
      }
      case 'undo_change': {
        const p = ActionParamSchemas.undo_change.parse(params);
        if (d.audit.getRow(p.auditId).undoneAt) return { stale: 'Die Änderung wurde bereits rückgängig gemacht.' };
        return { params };
      }
      case 'merge_open_items': {
        const p = ActionParamSchemas.merge_open_items.parse(params);
        const stale = d.openItemDuplicates.staleReason(p.keepId, p.duplicateId);
        return stale ? { stale } : { params };
      }
      case 'merge_notes':
      case 'merge_events': {
        const p = ActionParamSchemas[type].parse(params);
        const stale = d.noteEventDuplicates.staleReason(type === 'merge_notes' ? 'note' : 'event', p.keepId, p.duplicateId);
        return stale ? { stale } : { params };
      }
      default:
        return { params };
    }
  }

  /** Other open proposals that the executed action made obsolete are withdrawn, so nothing outdated can run later. */
  private afterExecuted(id: string, type: AgentActionType, params: Record<string, unknown>): void {
    if (type === 'merge_entities' || type === 'merge_topics') {
      // proposals that still name a merged-away entity can no longer run; the next archive check asks anew
      const gone = new Set(mergedIds(type, params).filter((x) => !this.deps.graph.getEntity(x)));
      for (const other of this.list('proposed')) {
        if (other.id === id || (other.actionType !== 'merge_entities' && other.actionType !== 'merge_topics')) continue;
        if (mergedIds(other.actionType, other.proposedParameters).some((x) => gone.has(x)))
          this.withdraw(other.id, 'Einer der Einträge wurde inzwischen mit einem anderen zusammengeführt.');
      }
    }
    if (type === 'relocate_documents') {
      const p = ActionParamSchemas.relocate_documents.parse(params);
      for (const other of this.openRelocationsFor(p.items.map((i) => i.documentId)))
        if (other.id !== id) this.withdraw(other.id, 'Die Dokumente wurden inzwischen durch einen anderen Vorschlag verschoben.');
    }
    if (type === 'supersede_decision') {
      const p = ActionParamSchemas.supersede_decision.parse(params);
      for (const other of this.list('proposed')) {
        if (other.id === id || other.actionType !== 'supersede_decision') continue;
        const o = ActionParamSchemas.supersede_decision.parse(other.proposedParameters);
        if (o.oldDecisionId === p.oldDecisionId) this.withdraw(other.id, 'Die ältere Entscheidung wurde bereits als überholt markiert.');
      }
      this.deps.contradictions.settlePair(p.oldDecisionId, p.newDecisionId);
    }
  }

  private async execute(type: AgentActionType, p: Record<string, never> & Record<string, unknown>): Promise<string> {
    const d = this.deps;
    const trigger = 'agent_action';
    switch (type) {
      case 'archive_documents': {
        const params = ActionParamSchemas.archive_documents.parse(p);
        const res = await d.archive.execute(params.items, {
          confirmed: true,
          approveNewCategories: params.approveNewCategories,
          confirmMove: params.items.some((i) => i.mode === 'move'),
          trigger,
        });
        return `${res.success} archiviert, ${res.skipped} übersprungen, ${res.failed} fehlgeschlagen, ${res.conflicts} Konflikte.`;
      }
      case 'relocate_documents': {
        const params = ActionParamSchemas.relocate_documents.parse(p);
        const res = await d.archive.relocate(params.items, { confirmed: true, trigger });
        const summary = `${res.success} verschoben, ${res.skipped} übersprungen, ${res.failed} fehlgeschlagen, ${res.conflicts} Konflikte.`;
        // Nothing moved although something should have: the action failed (an insight behind it stays open).
        if (res.success === 0 && res.failed + res.conflicts > 0) {
          const reasons = res.items.filter((i) => i.outcome === 'failed' || i.outcome === 'conflict').map((i) => i.message);
          throw new AppError(res.failed > 0 ? 'filesystem_error' : 'archive_conflict', `Es wurde nichts verschoben: ${summary}`, {
            details: [...new Set(reasons)].join(' '),
          });
        }
        return summary;
      }
      case 'assign_documents': {
        const params = ActionParamSchemas.assign_documents.parse(p);
        for (const id of params.documentIds) d.documents.assign(id, { topic: params.topic ?? undefined, project: params.project ?? undefined }, { trigger });
        return `${params.documentIds.length} Dokument(e) zugeordnet.`;
      }
      case 'supersede_decision': {
        const params = ActionParamSchemas.supersede_decision.parse(p);
        d.decisions.supersede(params.oldDecisionId, params.newDecisionId, { confirmed: true, trigger });
        return 'Ältere Entscheidung als überholt markiert.';
      }
      case 'revoke_decision': {
        const params = ActionParamSchemas.revoke_decision.parse(p);
        d.decisions.revoke(params.decisionId, { confirmed: true, trigger });
        return 'Entscheidung widerrufen.';
      }
      case 'resolve_contradiction': {
        const params = ActionParamSchemas.resolve_contradiction.parse(p);
        d.contradictions.resolve(params.contradictionId, params.resolution, {
          confirmed: true,
          supersedeOldDecisionId: params.supersedeOldDecisionId,
          supersedeNewDecisionId: params.supersedeNewDecisionId,
        });
        return 'Widerspruch aufgelöst.';
      }
      case 'close_open_item': {
        const params = ActionParamSchemas.close_open_item.parse(p);
        d.openItems.close(params.openItemId, params.status, { confirmed: true, trigger, resolutionNote: params.resolutionNote });
        return 'Offener Punkt geschlossen.';
      }
      case 'merge_topics': {
        const params = ActionParamSchemas.merge_topics.parse(p);
        const r = await d.graph.merge({ sourceIds: [params.sourceTopicId], targetId: params.targetTopicId }, { trigger, action: 'topics.merge' });
        return `Themen zusammengeführt (${r.relationsMoved} Beziehungen übernommen).`;
      }
      case 'merge_entities': {
        const params = ActionParamSchemas.merge_entities.parse(p);
        const r = await d.graph.merge({ sourceIds: params.sourceIds, targetId: params.targetId, allowCrossType: params.allowCrossType }, { trigger });
        return `${r.mergedNames.map((n) => `„${n}“`).join(', ')} mit „${r.targetName}“ zusammengeführt (${r.relationsMoved} Beziehungen, ${r.referencesUpdated} Verweise übernommen).`;
      }
      case 'merge_notes':
      case 'merge_events': {
        const params = ActionParamSchemas[type].parse(p);
        const opts = { actor: 'user' as const, trigger };
        const r =
          type === 'merge_notes'
            ? d.noteEventDuplicates.mergeNotes(params.keepId, params.duplicateId, opts)
            : d.noteEventDuplicates.mergeEvents(params.keepId, params.duplicateId, opts);
        return `„${r.duplicateTitle}“ als Duplikat von „${r.keepTitle}“ verworfen${r.takenOver.length ? `; übernommen: ${r.takenOver.join(', ')}` : ''}.`;
      }
      case 'confirm_relation': {
        const params = ActionParamSchemas.confirm_relation.parse(p);
        d.graph.setRelationStatus(params.relationId, 'confirmed');
        d.audit.log({ action: 'relation.confirm', actor: 'user', trigger, confirmed: true, entityIds: [params.relationId] });
        return 'Beziehung bestätigt.';
      }
      case 'reject_relation': {
        const params = ActionParamSchemas.reject_relation.parse(p);
        d.graph.setRelationStatus(params.relationId, 'rejected');
        d.audit.log({ action: 'relation.reject', actor: 'user', trigger, confirmed: true, entityIds: [params.relationId] });
        return 'Beziehung abgelehnt.';
      }
      case 'exclude_path': {
        const params = ActionParamSchemas.exclude_path.parse(p);
        d.scanner.exclude(params.kind, params.path);
        return 'Von künftigen Scans ausgeschlossen.';
      }
      case 'create_category': {
        const params = ActionParamSchemas.create_category.parse(p);
        d.archive.createCategory(params.path, true);
        return 'Kategorie angelegt.';
      }
      case 'set_reminder': {
        const params = ActionParamSchemas.set_reminder.parse(p);
        d.reminders.create({ targetType: params.targetType as 'custom', targetId: params.targetId, title: params.title, remindAt: params.remindAt });
        return 'Erinnerung angelegt.';
      }
      case 'create_open_item': {
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
          { actor: 'agent', trigger },
        );
        return 'Offener Punkt angelegt.';
      }
      case 'add_open_item_source': {
        const { openItemId, documentId, ...extra } = ActionParamSchemas.add_open_item_source.parse(p);
        d.openItems.addSource(openItemId, documentId, extra, { actor: 'agent', trigger });
        return 'Offener Punkt um Quelle ergänzt.';
      }
      case 'merge_open_items': {
        const params = ActionParamSchemas.merge_open_items.parse(p);
        const r = d.openItemDuplicates.merge(params.keepId, params.duplicateId, { trigger });
        return `„${r.duplicate.title}“ als Duplikat von „${r.keep.title}“ verworfen${r.takenOver.length ? `; übernommen: ${r.takenOver.join(', ')}` : ''}.`;
      }
      case 'undo_change': {
        const params = ActionParamSchemas.undo_change.parse(p);
        const r = await d.undo.undo(params.auditId);
        if (!r.undone) throw new AppError('validation_error', r.message, { details: r.conflicts.join(' ') || undefined });
        return r.message;
      }
      case 'agent_batch': {
        const params = ActionParamSchemas.agent_batch.parse(p);
        if (!d.agentBatch) throw new AppError('validation_error', 'Der Agentenmodus ist nicht verfügbar.');
        return d.agentBatch(params);
      }
      case 'record_decision': {
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
          { actor: 'agent', trigger },
        );
        return 'Entscheidung erfasst (ggf. als Entwurf mit offenen Pflichtfeldern).';
      }
    }
  }
}
