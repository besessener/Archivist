import { ACTIVE_DECISION_STATUSES, type Decision, type DecisionStatus } from '@archivist/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions, relations } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { AuditService } from './audit';
import type { DecisionRow } from './decision-fields';
import { DECISION_DELETE_UNDO_TYPE, DECISION_STATUS_UNDO_TYPE, type DecisionDeleteUndo, type DecisionStatusUndo } from './decision-undo';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';

export interface DecisionLifecycleDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  search: SearchService;
  audit: AuditService;
  get: (id: string) => Decision;
  row: (id: string) => DecisionRow;
  reindex: (id: string) => Promise<void>;
}

/** Superseding, revoking and deleting decisions: the changes that need an explicit confirmation and an undo entry. */
export class DecisionLifecycle {
  private readonly ctx: AppContext;
  private readonly graph: KnowledgeGraphService;
  private readonly search: SearchService;
  private readonly audit: AuditService;
  private readonly get: (id: string) => Decision;
  private readonly row: (id: string) => DecisionRow;
  private readonly reindex: (id: string) => Promise<void>;

  constructor(deps: DecisionLifecycleDeps) {
    ({ ctx: this.ctx, graph: this.graph, search: this.search, audit: this.audit, get: this.get, row: this.row, reindex: this.reindex } = deps);
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Stage 2: marks an older decision as superseded (only after confirmation by the user). */
  supersede({ oldId, newId, ...opts }: { oldId: string; newId: string; confirmed: boolean; trigger?: string }): { old: Decision; new: Decision } {
    if (!opts.confirmed) throw new AppError('permission_error', 'Eine Entscheidung darf nur nach ausdrücklicher Bestätigung als überholt markiert werden.');
    if (oldId === newId) throw new AppError('validation_error', 'Eine Entscheidung kann sich nicht selbst ersetzen.');
    const oldRow = this.db.select().from(decisions).where(eq(decisions.id, oldId)).get();
    const newRow = this.db.select().from(decisions).where(eq(decisions.id, newId)).get();
    if (!oldRow || !newRow) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    // idempotent: superseding the same pair twice changes nothing (and logs nothing)
    if (oldRow.status === 'superseded' && this.get(oldId).supersededBy.some((successor) => successor.id === newId))
      return { old: this.get(oldId), new: this.get(newId) };
    if (oldRow.status === 'superseded' || oldRow.status === 'revoked')
      throw new AppError('validation_error', 'Die ältere Entscheidung ist bereits überholt oder widerrufen.');
    if (!ACTIVE_DECISION_STATUSES.includes(newRow.status as DecisionStatus))
      throw new AppError(
        'validation_error',
        'Die neue Entscheidung muss gültig oder bestätigt sein. Ein Entwurf oder eine unklare, ersetzte oder widerrufene Entscheidung ersetzt keine andere.',
      );
    const now = nowIso();
    // an already existing (e.g. user-rejected) supersedes relation is not part of the undo data
    const { changes: relations } = this.graph.trackRelationChanges(newId, () =>
      this.db.transaction(() => {
        this.db.update(decisions).set({ status: 'superseded', updatedAt: now }).where(eq(decisions.id, oldId)).run();
        // the column names the first one replaced; further ones live in the `supersedes` relations only
        this.db
          .update(decisions)
          .set({ supersedesDecisionId: newRow.supersedesDecisionId ?? oldId, updatedAt: now })
          .where(eq(decisions.id, newId))
          .run();
        this.graph.link({ sourceId: newId, targetId: oldId, relationType: 'supersedes' }, { confidence: 0.95, status: 'confirmed' });
      }),
    );
    const statusChange = (row: DecisionRow) => ({ id: row.id, status: row.status, supersedesDecisionId: row.supersedesDecisionId, afterUpdatedAt: now });
    this.audit.log({
      action: 'decision.supersede',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [oldId, newId],
      before: { oldStatus: oldRow.status },
      after: { oldStatus: 'superseded', newSupersedes: oldId },
      undo: { type: DECISION_STATUS_UNDO_TYPE, data: { changes: [statusChange(oldRow), statusChange(newRow)], relations } satisfies DecisionStatusUndo },
    });
    void this.reindex(oldId);
    void this.reindex(newId);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return { old: this.get(oldId), new: this.get(newId) };
  }

  revoke(id: string, opts: { confirmed: boolean; trigger?: string }): Decision {
    if (!opts.confirmed) throw new AppError('permission_error', 'Eine Entscheidung darf nur nach ausdrücklicher Bestätigung widerrufen werden.');
    const current = this.row(id);
    const now = nowIso();
    this.db.update(decisions).set({ status: 'revoked', updatedAt: now }).where(eq(decisions.id, id)).run();
    this.audit.log({
      action: 'decision.revoke',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: current.status },
      after: { status: 'revoked' },
      undo: {
        type: DECISION_STATUS_UNDO_TYPE,
        data: {
          changes: [{ id, status: current.status, supersedesDecisionId: current.supersedesDecisionId, afterUpdatedAt: now }],
          relations: { created: [], changed: [] },
        } satisfies DecisionStatusUndo,
      },
    });
    void this.reindex(id);
    this.ctx.events.changed('decisions', 'status');
    return this.get(id);
  }

  /** Deletes a draft or unclear decision (created in error); a valid one is revoked instead. Returns the audit entry whose undo restores it. */
  delete(id: string, opts: { confirmed: boolean; trigger?: string }): string {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Löschen einer Entscheidung erfordert eine ausdrückliche Bestätigung.');
    const current = this.row(id);
    if (current.status !== 'draft' && current.status !== 'unclear')
      throw new AppError('validation_error', 'Gelöscht werden nur Entwürfe und unklare Entscheidungen. Eine gültige Entscheidung widerrufst du.');
    if (this.replacedAnother(current))
      throw new AppError('validation_error', 'Diese Entscheidung hat eine andere ersetzt. Sie lässt sich deshalb nicht löschen.');
    const undoData: DecisionDeleteUndo = { decision: current, node: this.graph.snapshotNode(id) };
    this.db.transaction(() => {
      this.db.delete(decisions).where(eq(decisions.id, id)).run();
      this.graph.removeNode(id);
    });
    this.search.remove(id);
    const auditId = this.audit.log({
      action: 'decision.delete',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: current.title, status: current.status, decidedAt: current.decidedAt },
      undo: { type: DECISION_DELETE_UNDO_TYPE, data: undoData },
    });
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return auditId;
  }

  /** Via the `supersedes` column (the first one replaced) or a confirmed `supersedes` relation to another decision (further ones). */
  private replacedAnother(row: DecisionRow): boolean {
    if (row.supersedesDecisionId) return true;
    const replaced = this.db
      .select({ id: relations.id })
      .from(relations)
      .innerJoin(decisions, eq(decisions.id, relations.targetEntityId))
      .where(and(eq(relations.sourceEntityId, row.id), eq(relations.relationType, 'supersedes'), eq(relations.status, 'confirmed')))
      .get();
    return replaced !== undefined;
  }
}
