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
import { executeAction } from './action-executors';
import { mergedIds, revalidate, type Revalidation } from './action-revalidation';
import type { ArchiveService } from './archive';
import type { AuditService } from './audit';
import type { NoteEventDuplicateService } from './cleanup/note-event-duplicates';
import type { OpenItemDuplicateService } from './cleanup/open-item-duplicates';
import type { ContradictionService } from './contradictions';
import type { DecisionService } from './decisions';
import type { DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { OpenItemService } from './open-items';
import type { ReminderService } from './reminders';
import type { ScannerService } from './scanner';
import type { UndoService } from './undo';

type Row = typeof agentActions.$inferSelect;

const toStoredAction = (r: Row): StoredAgentAction => ({
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

/** Agent actions: the agent only proposes; execution happens exclusively through `resolve` after the user's decision. */
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
    // relocating many documents at once needs the confirmation dialog; a typed „ja“ in the chat is not enough (#199)
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
    return toStoredAction(row);
  }

  get(id: string): StoredAgentAction {
    const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Aktion nicht gefunden.');
    return toStoredAction(r);
  }

  getMany(ids: string[]): StoredAgentAction[] {
    return ids.flatMap((id) => {
      const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
      return r ? [toStoredAction(r)] : [];
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
      .map(toStoredAction);
  }

  /** Open proposals shown as a card in this conversation and originating there, in the order they were shown. */
  openInConversation(conversationId: string, shownActionIds: string[]): StoredAgentAction[] {
    return this.getMany([...new Set(shownActionIds)]).filter((a) => a.status === 'proposed' && a.conversationId === conversationId);
  }

  /** Retracts an undecided proposal without executing it (status `withdrawn`); false if it was already decided. */
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
    if (decision === 'reject') return this.reject(action);
    return this.approve(action, opts);
  }

  private reject(action: StoredAgentAction): StoredAgentAction {
    this.db.update(agentActions).set({ status: 'rejected', resolvedAt: nowIso() }).where(eq(agentActions.id, action.id)).run();
    // a relation card has confirm and reject: rejecting discards the proposed relation, logged with undo (#283)
    if (action.actionType === 'confirm_relation') {
      const params = ActionParamSchemas.confirm_relation.parse(action.proposedParameters);
      this.deps.graph.decideRelation(params.relationId, 'rejected', { trigger: 'confirmation' });
    }
    this.deps.audit.log({
      action: `action.reject:${action.actionType}`,
      actor: 'user',
      trigger: 'confirmation',
      confirmed: true,
      entityIds: action.affectedEntities.map((e) => e.id),
    });
    this.ctx.events.changed('status', 'insights');
    return this.get(action.id);
  }

  private async approve(
    action: StoredAgentAction,
    opts: { confirmed?: boolean; strongConfirmed?: boolean; overrides?: Record<string, unknown> },
  ): Promise<StoredAgentAction> {
    if (!opts.confirmed) throw new AppError('permission_error', 'Diese Aktion erfordert eine ausdrückliche Bestätigung.');
    if (action.requiredConfirmation === 'strong' && !opts.strongConfirmed) {
      throw new AppError('permission_error', 'Diese Aktion ist besonders kritisch und erfordert eine zweite, ausdrückliche Bestätigung.');
    }
    const requested = { ...action.proposedParameters, ...(opts.overrides ?? {}) };
    const parsed = ActionParamSchemas[action.actionType].safeParse(requested);
    let params: Record<string, unknown> | null = parsed.success ? parsed.data : null; // invalid parameters fail below
    if (params) {
      const checked = this.recheck(action.actionType, params);
      if ('stale' in checked) {
        // the world changed since the proposal: never execute outdated parameters (e.g. move a document back)
        this.withdraw(action.id, `Nicht ausgeführt, der Vorschlag ist nicht mehr aktuell: ${checked.stale}`);
        return this.get(action.id);
      }
      params = checked.params;
    }
    this.db.update(agentActions).set({ status: 'approved' }).where(eq(agentActions.id, action.id)).run();
    const executed = await this.run(action, { params, requested });
    if (executed) {
      try {
        this.afterExecuted(action.id, { type: action.actionType, params: executed });
      } catch (err) {
        this.ctx.logger.warn('actions', 'Could not withdraw outdated proposals', { error: err });
      }
    }
    this.ctx.events.changed('status', 'insights', 'notifications');
    return this.get(action.id);
  }

  /** Revalidation against the current state; an error while checking also makes the proposal stale. */
  private recheck(type: AgentActionType, params: Record<string, unknown>): Revalidation {
    try {
      return revalidate(this.deps, { type, params });
    } catch (err) {
      return { stale: toErrorInfo(err).message };
    }
  }

  /** Runs the action and stores its result; returns the executed parameters, or null when it failed. */
  private async run(
    action: StoredAgentAction,
    input: { params: Record<string, unknown> | null; requested: Record<string, unknown> },
  ): Promise<Record<string, unknown> | null> {
    try {
      const valid = input.params ?? ActionParamSchemas[action.actionType].parse(input.requested);
      const result = await executeAction(this.deps, { type: action.actionType, params: valid });
      this.db.update(agentActions).set({ status: 'executed', result, resolvedAt: nowIso() }).where(eq(agentActions.id, action.id)).run();
      return valid;
    } catch (err) {
      const info = toErrorInfo(err);
      this.ctx.logger.error('actions', `Action failed: ${action.actionType}`, { error: err });
      this.db
        .update(agentActions)
        .set({ status: 'failed', result: info.message + (info.details ? ` (${info.details})` : ''), resolvedAt: nowIso() })
        .where(eq(agentActions.id, action.id))
        .run();
      return null;
    }
  }

  /** Other open proposals that the executed action made obsolete are withdrawn, so nothing outdated can run later. */
  private afterExecuted(id: string, executed: { type: AgentActionType; params: Record<string, unknown> }): void {
    const { type, params } = executed;
    if (type === 'merge_entities' || type === 'merge_topics') this.withdrawMergedAway(id, mergedIds(type, params));
    if (type === 'relocate_documents') {
      const p = ActionParamSchemas.relocate_documents.parse(params);
      for (const other of this.openRelocationsFor(p.items.map((i) => i.documentId)))
        if (other.id !== id) this.withdraw(other.id, 'Die Dokumente wurden inzwischen durch einen anderen Vorschlag verschoben.');
    }
    if (type === 'supersede_decision') this.withdrawSuperseded(id, ActionParamSchemas.supersede_decision.parse(params));
  }

  /** Proposals that still name a merged-away entity can no longer run; the next archive check asks anew. */
  private withdrawMergedAway(id: string, merged: string[]): void {
    const gone = new Set(merged.filter((x) => !this.deps.graph.getEntity(x)));
    for (const other of this.list('proposed')) {
      if (other.id === id || (other.actionType !== 'merge_entities' && other.actionType !== 'merge_topics')) continue;
      if (mergedIds(other.actionType, other.proposedParameters).some((x) => gone.has(x)))
        this.withdraw(other.id, 'Einer der Einträge wurde inzwischen mit einem anderen zusammengeführt.');
    }
  }

  private withdrawSuperseded(id: string, superseded: { oldDecisionId: string; newDecisionId: string }): void {
    for (const other of this.list('proposed')) {
      if (other.id === id || other.actionType !== 'supersede_decision') continue;
      const o = ActionParamSchemas.supersede_decision.parse(other.proposedParameters);
      if (o.oldDecisionId === superseded.oldDecisionId) this.withdraw(other.id, 'Die ältere Entscheidung wurde bereits als überholt markiert.');
    }
    this.deps.contradictions.settlePair(superseded.oldDecisionId, superseded.newDecisionId);
  }
}
