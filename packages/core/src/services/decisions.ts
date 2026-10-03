import { DECISION_FIELD_LABELS, type Decision, type DecisionField, type DecisionInput, type DecisionPatch, type DecisionStatus } from '@archivist/shared';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions, entities } from '../db/schema';
import { withSubject } from '../db/subject-filter';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput, toIsoDate } from '../util/dates';
import { firstSentence } from '../util/text';
import type { AuditService } from './audit';
import {
  assertEditableStatusChange,
  checkedDecisionDate,
  computeMissingFields,
  decisionIndexContent,
  decisionSummary,
  formatDecision,
  plainPatchColumns,
  statusAfterEdit,
  toDecision,
  type DecisionRow,
} from './decision-fields';
import { DECISION_STATUS_UNDO_TYPE, DECISION_UPDATE_UNDO_TYPE, registerDecisionUndo, type DecisionStatusUndo, type DecisionUpdateUndo } from './decision-undo';
import type { KnowledgeGraphService } from './knowledge-graph';
import { mentionContext, type PersonMentionContext, type PersonService } from './persons';
import { previousValues } from './previous-values';
import type { SearchService } from './search';
import type { UndoService } from './undo';

export { computeMissingFields, questionFor } from './decision-fields';

export const ACTIVE_DECISION_STATUSES: DecisionStatus[] = ['confirmed', 'active'];

const today = () => toIsoDate(new Date());

export interface DecisionServiceDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  persons: PersonService;
  search: SearchService;
  audit: AuditService;
  undo: UndoService;
}

export class DecisionService {
  private readonly ctx: AppContext;
  private readonly graph: KnowledgeGraphService;
  private readonly persons: PersonService;
  private readonly search: SearchService;
  private readonly audit: AuditService;

  constructor(deps: DecisionServiceDeps) {
    ({ ctx: this.ctx, graph: this.graph, persons: this.persons, search: this.search, audit: this.audit } = deps);
    const { ctx, graph, undo } = deps;
    registerDecisionUndo(undo, { ctx, graph, reindex: (id) => this.reindex(id) });
  }

  private get db() {
    return this.ctx.database.db;
  }

  private row(id: string): DecisionRow {
    const row = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    return row;
  }

  private map(row: DecisionRow, names?: Map<string, string>): Decision {
    return toDecision(row, (id) => (id ? (names?.get(id) ?? this.graph.getEntity(id)?.name ?? null) : null));
  }

  private mapMany(rows: DecisionRow[]): Decision[] {
    const ids = [...new Set(rows.flatMap((row) => [row.topicId, row.projectId]).filter((id): id is string => Boolean(id)))];
    const names = new Map(
      ids.length
        ? this.db
            .select({ id: entities.id, name: entities.name })
            .from(entities)
            .where(inArray(entities.id, ids))
            .all()
            .map((entity) => [entity.id, entity.name])
        : [],
    );
    return rows.map((row) => this.map(row, names));
  }

  get(id: string): Decision {
    return this.map(this.row(id));
  }

  list(opts: { status?: DecisionStatus; topicId?: string; projectId?: string } = {}): Decision[] {
    const conditions = [];
    if (opts.status) conditions.push(eq(decisions.status, opts.status));
    // the main topic/project or a further one (#287)
    if (opts.topicId) conditions.push(withSubject(decisions.id, decisions.topicId, opts.topicId));
    if (opts.projectId) conditions.push(withSubject(decisions.id, decisions.projectId, opts.projectId));
    return this.mapMany(
      this.db
        .select()
        .from(decisions)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(decisions.decidedAt), desc(decisions.createdAt))
        .all(),
    );
  }

  /** Active decisions on a topic or project (for the contradiction/superseded check). */
  activeFor(topicId: string | null, projectId: string | null, excludeId?: string): Decision[] {
    const all = this.list().filter((d) => ACTIVE_DECISION_STATUSES.includes(d.status) && d.id !== excludeId);
    return all.filter((d) => (topicId && d.topicId === topicId) || (!topicId && projectId && d.projectId === projectId));
  }

  async searchDecisions(query: string, limit = 20): Promise<Decision[]> {
    const hits = await this.search.search(query, { types: ['decision'], limit });
    const ids = hits.map((hit) => hit.id);
    const found = ids.length ? this.db.select().from(decisions).where(inArray(decisions.id, ids)).all() : [];
    const byId = new Map(found.map((row) => [row.id, row]));
    const ordered = ids.flatMap((id) => byId.get(id) ?? []);
    if (ordered.length) return this.mapMany(ordered);
    const pattern = `%${query.trim()}%`;
    return this.mapMany(
      this.db
        .select()
        .from(decisions)
        .where(or(like(decisions.title, pattern), like(decisions.decisionText, pattern)))
        .limit(limit)
        .all(),
    );
  }

  /** Creates a decision; with open required fields (not confirmed as unknown) it is saved as a draft. */
  create(input: DecisionInput, opts: { actor?: 'user' | 'agent'; trigger?: string } = {}): Decision {
    const personContext = mentionContext(opts.trigger, 'decision');
    const row = this.newRow(input, { personContext, trigger: opts.trigger });
    this.db.transaction(() => {
      this.db.insert(decisions).values(row).run();
      this.syncGraph(row, personContext);
    });
    this.audit.log({
      action: 'decision.create',
      actor: opts.actor ?? 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: row.status !== 'draft',
      entityIds: [row.id],
      after: { title: row.title, status: row.status, missing: row.missingFields },
    });
    this.ctx.events.created({ id: row.id, type: 'decision' });
    void this.reindex(row.id);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return this.get(row.id);
  }

  private newRow(input: DecisionInput, opts: { personContext: PersonMentionContext; trigger?: string }): DecisionRow {
    const now = nowIso();
    const topic = input.topic?.trim() ? this.graph.ensureEntity('topic', input.topic) : null;
    const project = input.project?.trim() ? this.graph.ensureEntity('project', input.project) : null;
    const decidedAt = checkedDecisionDate(input.decidedAt, today());
    const participants = this.persons.resolveNames(input.participants, { context: opts.personContext }).names;
    const missing = computeMissingFields({ ...input, decidedAt, topic: topic?.name ?? null, participants });
    return {
      id: newId(),
      title: input.title?.trim() || firstSentence(input.decisionText, 90),
      decisionText: input.decisionText.trim(),
      decidedAt,
      topicId: topic?.id ?? null,
      projectId: project?.id ?? null,
      participants,
      rationale: input.rationale?.trim() || null,
      consequences: input.consequences?.trim() || null,
      alternatives: input.alternatives,
      status: input.asDraft || missing.length > 0 ? 'draft' : 'active',
      validFrom: normalizeDateInput(input.validFrom ?? null),
      validUntil: normalizeDateInput(input.validUntil ?? null),
      supersedesDecisionId: null,
      sourceIds: input.sourceIds,
      confidence: input.confidence,
      missingFields: missing,
      unknownFields: input.unknownFields,
      origin: input.origin ?? (opts.trigger === 'chat' ? 'chat' : 'form'),
      evidence: input.evidence?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Partial update of the fields in `patch`; `unknownFields` is replaced, `sourceIds` are added (supersede/revoke have own actions). */
  update(id: string, patch: DecisionPatch, opts: { trigger?: string } = {}): Decision {
    const current = this.row(id);
    // runtime guard for internal callers as well (the IPC schema already rejects these statuses)
    assertEditableStatusChange(current.status as DecisionStatus, patch.status);
    const personContext = mentionContext(opts.trigger, 'decision');
    const set: Partial<DecisionRow> = { updatedAt: nowIso(), ...this.patchColumns(current, { patch, personContext }) };
    const merged = { ...current, ...set };
    const missing = computeMissingFields({
      ...merged,
      topic: merged.topicId ? (this.graph.getEntity(merged.topicId)?.name ?? null) : null,
      unknownFields: merged.unknownFields as DecisionField[],
    });
    set.missingFields = missing;
    const status = statusAfterEdit(current.status as DecisionStatus, { patch, missing });
    if (status) set.status = status;
    const { changes } = this.graph.trackRelationChanges(id, () =>
      this.db.transaction(() => {
        this.db.update(decisions).set(set).where(eq(decisions.id, id)).run();
        this.syncGraph({ ...current, ...set }, personContext);
      }),
    );
    const undoData: DecisionUpdateUndo = { id, before: previousValues(current, set), afterUpdatedAt: set.updatedAt!, relations: changes };
    this.audit.log({
      action: 'decision.update',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: current.status, decidedAt: current.decidedAt },
      after: { status: set.status ?? current.status, missing },
      undo: { type: DECISION_UPDATE_UNDO_TYPE, data: undoData },
    });
    void this.reindex(id);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return this.get(id);
  }

  /** The patch's columns; the date is checked before topics, projects and persons are created. */
  private patchColumns(current: DecisionRow, { patch, personContext }: { patch: DecisionPatch; personContext: PersonMentionContext }): Partial<DecisionRow> {
    const set: Partial<DecisionRow> = {};
    if (patch.decidedAt !== undefined) set.decidedAt = checkedDecisionDate(patch.decidedAt, today());
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.graph.ensureEntity('topic', patch.topic).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.graph.ensureEntity('project', patch.project).id : null;
    if (patch.participants !== undefined) set.participants = this.persons.resolveNames(patch.participants, { context: personContext }).names;
    return { ...plainPatchColumns(current, patch), ...set };
  }

  private syncGraph(row: DecisionRow, personContext: PersonMentionContext): void {
    const link = { confidence: row.confidence, status: 'confirmed' as const, sourceIds: row.sourceIds };
    this.graph.registerNode('decision', row.id, row.title, row.decisionText);
    if (row.topicId) this.graph.link(row.id, row.topicId, 'concerns', link);
    if (row.projectId) this.graph.link(row.id, row.projectId, 'affects', link);
    const personIds: string[] = [];
    for (const person of this.persons.resolveNames(row.participants, { context: personContext }).entities) {
      personIds.push(person.id);
      this.graph.link(person.id, row.id, 'participated_in', link);
    }
    // relations to a previous topic, project or participant no longer apply
    this.graph.unlinkSystemRelations(row.id, 'concerns', row.topicId ? [row.topicId] : [], { otherType: 'topic' });
    this.graph.unlinkSystemRelations(row.id, 'affects', row.projectId ? [row.projectId] : [], { otherType: 'project' });
    this.graph.unlinkSystemRelations(row.id, 'participated_in', personIds, { direction: 'in', otherType: 'person' });
    for (const sourceId of row.sourceIds) {
      if (this.graph.getEntity(sourceId)?.type === 'document')
        this.graph.link(sourceId, row.id, 'supports', { confidence: Math.min(row.confidence, 0.8), status: 'proposed', sourceIds: [sourceId] });
    }
  }

  /** Human-readable rendering (when/topic/participants/…). */
  format(d: Decision): string {
    return formatDecision(d);
  }

  missingLabels(d: Decision): string[] {
    return d.missingFields.map((field) => DECISION_FIELD_LABELS[field]);
  }

  /** Stage 2: marks an older decision as superseded (only after confirmation by the user). */
  supersede(oldId: string, newId: string, opts: { confirmed: boolean; trigger?: string }): { old: Decision; new: Decision } {
    if (!opts.confirmed) throw new AppError('permission_error', 'Eine Entscheidung darf nur nach ausdrücklicher Bestätigung als überholt markiert werden.');
    if (oldId === newId) throw new AppError('validation_error', 'Eine Entscheidung kann sich nicht selbst ersetzen.');
    const oldRow = this.db.select().from(decisions).where(eq(decisions.id, oldId)).get();
    const newRow = this.db.select().from(decisions).where(eq(decisions.id, newId)).get();
    if (!oldRow || !newRow) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    // idempotent: superseding the same pair twice changes nothing (and logs nothing)
    if (oldRow.status === 'superseded' && newRow.supersedesDecisionId === oldId) return { old: this.get(oldId), new: this.get(newId) };
    if (oldRow.status === 'superseded' || oldRow.status === 'revoked')
      throw new AppError('validation_error', 'Die ältere Entscheidung ist bereits überholt oder widerrufen.');
    const now = nowIso();
    // an already existing (e.g. user-rejected) supersedes relation is not part of the undo data
    const { changes: relations } = this.graph.trackRelationChanges(newId, () =>
      this.db.transaction(() => {
        this.db.update(decisions).set({ status: 'superseded', updatedAt: now }).where(eq(decisions.id, oldId)).run();
        this.db.update(decisions).set({ supersedesDecisionId: oldId, updatedAt: now }).where(eq(decisions.id, newId)).run();
        this.graph.link(newId, oldId, 'supersedes', { confidence: 0.95, status: 'confirmed' });
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

  /** Rebuilds the search index entry (e.g. after a merge changed names or references). */
  async reindex(id: string): Promise<void> {
    try {
      const d = this.get(id);
      await this.search.index({ type: 'decision', id, title: d.title, content: decisionIndexContent(d) });
    } catch (err) {
      this.ctx.logger.warn('decisions', 'Indexing failed', { error: err });
    }
  }

  summary(d: Decision): string {
    return decisionSummary(d);
  }
}
