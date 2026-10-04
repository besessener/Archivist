import { ActionParamSchemas, type AgentActionProposal, type AgentActionStatus, type AgentActionType, type StoredAgentAction } from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentActions } from '../db/schema';
import { AppError, toErrorInfo } from '../util/errors';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import type { ActionDeps, AgentBatchExecutor } from './action-deps';
import { executeAction } from './action-executors';
import { type ActionRow, MAX_PAGE_SIZE, pageOfActions, resolveSettledNotifications, toStoredAction } from './action-store';
import { mergedIds, revalidate, type Revalidation } from './action-revalidation';

/** From this many documents a relocation counts as especially far-reaching („besonders folgenreich“). */
const STRONG_RELOCATION_DOCUMENTS = 20;

/** Job type that executes a confirmed big action in the background (#254). */
export const ACTION_EXECUTE_JOB = 'action.execute';

/** From this many documents archiving or relocating runs as a job. */
const BACKGROUND_ITEMS = 10;

/** How long the confirming caller waits for such a job before it answers „läuft im Hintergrund“. */
const BACKGROUND_WAIT_MS = 15_000;

const runsInBackground = (type: AgentActionType, params: Record<string, unknown> | null): boolean =>
  (type === 'archive_documents' || type === 'relocate_documents') && ((params?.items as unknown[] | undefined)?.length ?? 0) >= BACKGROUND_ITEMS;

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
    const row: ActionRow = {
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
    if (!ids.length) return [];
    const rows = new Map(
      this.db
        .select()
        .from(agentActions)
        .where(inArray(agentActions.id, ids))
        .all()
        .map((r) => [r.id, r]),
    );
    return ids.flatMap((id) => {
      const r = rows.get(id);
      return r ? [toStoredAction(r)] : [];
    });
  }

  list(status?: StoredAgentAction['status']): StoredAgentAction[] {
    return this.page({ status, limit: MAX_PAGE_SIZE, offset: 0 });
  }

  page(query: { status?: AgentActionStatus; actionType?: AgentActionType; limit: number; offset: number }): StoredAgentAction[] {
    return pageOfActions(this.db, query);
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
    this.resolveSettledNotifications();
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
    { decision, ...opts }: { decision: 'approve' | 'reject'; confirmed?: boolean; strongConfirmed?: boolean; overrides?: Record<string, unknown> },
  ): Promise<StoredAgentAction> {
    const action = this.get(id);
    if (action.status !== 'proposed') return action;
    const decided = decision === 'reject' ? this.reject(action) : await this.approve(action, opts);
    this.resolveSettledNotifications();
    return decided;
  }

  private resolveSettledNotifications(): void {
    resolveSettledNotifications(this.deps.notifications, (ids) => this.getMany(ids));
  }

  private reject(action: StoredAgentAction): StoredAgentAction {
    this.db.update(agentActions).set({ status: 'rejected', resolvedAt: nowIso() }).where(eq(agentActions.id, action.id)).run();
    // a relation card has confirm and reject: rejecting discards the proposed relation, logged with undo (#283)
    if (action.actionType === 'confirm_relation') {
      const params = ActionParamSchemas.confirm_relation.parse(action.proposedParameters);
      this.deps.graph.decideRelation(params.relationId, { status: 'rejected', trigger: 'confirmation' });
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
    const prepared = this.prepare(action, opts.overrides ?? {});
    if ('stale' in prepared) {
      // the world changed since the proposal: never execute outdated parameters (e.g. move a document back)
      this.withdraw(action.id, `Nicht ausgeführt, der Vorschlag ist nicht mehr aktuell: ${prepared.stale}`);
      return this.get(action.id);
    }
    this.db.update(agentActions).set({ status: 'approved' }).where(eq(agentActions.id, action.id)).run();
    if (runsInBackground(action.actionType, prepared.params)) return this.runViaJob(action, opts.overrides ?? {});
    await this.execute(action, prepared);
    return this.get(action.id);
  }

  /** Validated parameters (with the user's overrides) and the check against the current state. */
  private prepare(
    action: StoredAgentAction,
    overrides: Record<string, unknown>,
  ): { params: Record<string, unknown> | null; requested: Record<string, unknown> } | { stale: string } {
    const requested = { ...action.proposedParameters, ...overrides };
    const parsed = ActionParamSchemas[action.actionType].safeParse(requested);
    if (!parsed.success) return { params: null, requested }; // invalid parameters fail in `run`
    const checked = this.recheck(action.actionType, parsed.data);
    return 'stale' in checked ? { stale: checked.stale } : { params: checked.params, requested };
  }

  private async execute(action: StoredAgentAction, input: { params: Record<string, unknown> | null; requested: Record<string, unknown> }): Promise<void> {
    const executed = await this.run(action, input);
    if (executed) {
      try {
        this.afterExecuted(action.id, { type: action.actionType, params: executed });
      } catch (err) {
        this.ctx.logger.warn('actions', 'Could not withdraw outdated proposals', { error: err });
      }
    }
    this.ctx.events.changed('status', 'insights', 'notifications');
  }

  /** Big actions run as a job (visible under Jobs); the caller still gets the result if it arrives within a short wait (#254). */
  private async runViaJob(action: StoredAgentAction, overrides: Record<string, unknown>): Promise<StoredAgentAction> {
    const job = this.deps.jobs.enqueue(ACTION_EXECUTE_JOB, { label: action.label, payload: { actionId: action.id, overrides }, maxAttempts: 1 });
    await this.deps.jobs.waitFor(job.id, BACKGROUND_WAIT_MS);
    return this.get(action.id);
  }

  /** The job of a confirmed big action: the same preparation and execution as inline, nothing for an action that is no longer `approved`. */
  async executeApproved(id: string, overrides: Record<string, unknown>): Promise<void> {
    const action = this.get(id);
    if (action.status !== 'approved') return;
    const prepared = this.prepare(action, overrides);
    if ('stale' in prepared) {
      this.withdraw(id, `Nicht ausgeführt, der Vorschlag ist nicht mehr aktuell: ${prepared.stale}`);
      return;
    }
    await this.execute(action, prepared);
  }

  /** The job ended without a result (failed, cancelled, interrupted): the card must not stay „Bestätigt“ forever. */
  markNotExecuted(id: string, reason: string): void {
    if (this.get(id).status !== 'approved') return;
    this.db.update(agentActions).set({ status: 'failed', result: reason, resolvedAt: nowIso() }).where(eq(agentActions.id, id)).run();
    this.ctx.events.changed('status', 'insights', 'notifications');
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
