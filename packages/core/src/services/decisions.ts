import {
  ACTIVE_DECISION_STATUSES,
  DECISION_FIELD_LABELS,
  type Decision,
  type DecisionField,
  type DecisionInput,
  type DecisionPatch,
  type DecisionStatus,
  type EditableDecisionStatus,
} from '@archivist/shared';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions, entities } from '../db/schema';
import { withSubject } from '../db/subject-filter';
import { CREATED_UNDO_TYPE } from '../agent/created-undo';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput, toIsoDate } from '../util/dates';
import { firstSentence } from '../util/text';
import type { AuditService } from './audit';
import { trackedChanges } from './decision-audit';
import { findDecisionDuplicate } from './decision-duplicates';
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
import { DecisionLifecycle } from './decision-lifecycle';
import { successorsOf } from './decision-successors';
import { DECISION_UPDATE_UNDO_TYPE, registerDecisionUndo, type DecisionUpdateUndo } from './decision-undo';
import type { KnowledgeGraphService } from './knowledge-graph';
import { mentionContext, type PersonMentionContext, type PersonService } from './persons';
import { previousValues } from './previous-values';
import type { SearchService } from './search';
import type { UndoService } from './undo';

export { computeMissingFields, questionFor } from './decision-fields';

export { ACTIVE_DECISION_STATUSES };

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
  private readonly statusUndoneListeners: Array<(decisionIds: string[]) => void> = [];
  private readonly lifecycle: DecisionLifecycle;

  constructor(deps: DecisionServiceDeps) {
    ({ ctx: this.ctx, graph: this.graph, persons: this.persons, search: this.search, audit: this.audit } = deps);
    const { ctx, graph, undo } = deps;
    registerDecisionUndo(undo, {
      ctx,
      graph,
      reindex: (id) => this.reindex(id),
      statusUndone: (ids) => this.statusUndoneListeners.forEach((listener) => listener(ids)),
    });
    this.lifecycle = new DecisionLifecycle({
      ctx,
      graph,
      search: this.search,
      audit: this.audit,
      get: (id) => this.get(id),
      row: (id) => this.row(id),
      reindex: (id) => this.reindex(id),
    });
  }

  /** Registers a listener for undone status changes (supersede, revoke). */
  onStatusUndone(listener: (decisionIds: string[]) => void): void {
    this.statusUndoneListeners.push(listener);
  }

  private get db() {
    return this.ctx.database.db;
  }

  private row(id: string): DecisionRow {
    const row = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    return row;
  }

  private map(row: DecisionRow, lookups: { names?: Map<string, string>; successors?: Map<string, Decision['supersededBy']> } = {}): Decision {
    const successors = lookups.successors ?? successorsOf(this.db, [row.id]);
    return toDecision(row, (id) => (id ? (lookups.names?.get(id) ?? this.graph.getEntity(id)?.name ?? null) : null), successors.get(row.id) ?? []);
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
    const successors = successorsOf(
      this.db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => this.map(row, { names, successors }));
  }

  get(id: string): Decision {
    return this.map(this.row(id));
  }

  list(opts: { status?: DecisionStatus; topicId?: string; projectId?: string } = {}): Decision[] {
    const conditions = [];
    if (opts.status) conditions.push(eq(decisions.status, opts.status));
    // the main topic/project or a further one (#287)
    if (opts.topicId) conditions.push(withSubject({ idCol: decisions.id, mainCol: decisions.topicId, subjectId: opts.topicId }));
    if (opts.projectId) conditions.push(withSubject({ idCol: decisions.id, mainCol: decisions.projectId, subjectId: opts.projectId }));
    return this.mapMany(
      this.db
        .select()
        .from(decisions)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(decisions.decidedAt), desc(decisions.createdAt))
        .all(),
    );
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
  create(input: DecisionInput, opts: { actor?: 'user' | 'agent'; trigger?: string; status?: Exclude<EditableDecisionStatus, 'draft'> } = {}): Decision {
    const personContext = mentionContext(opts.trigger, 'decision');
    const row = this.newRow(input, { personContext, trigger: opts.trigger, status: opts.status });
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
      undo: { type: CREATED_UNDO_TYPE, data: { action: 'decision.create', id: row.id } },
    });
    this.ctx.events.created({ id: row.id, type: 'decision' });
    void this.reindex(row.id);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return this.get(row.id);
  }

  private newRow(
    input: DecisionInput,
    opts: { personContext: PersonMentionContext; trigger?: string; status?: Exclude<EditableDecisionStatus, 'draft'> },
  ): DecisionRow {
    const now = nowIso();
    const topic = input.topic?.trim() ? this.graph.ensureEntity({ type: 'topic', name: input.topic }) : null;
    const project = input.project?.trim() ? this.graph.ensureEntity({ type: 'project', name: input.project }) : null;
    const decidedAt = checkedDecisionDate(input.decidedAt, today());
    const participants = this.persons.resolveNames(input.participants, { context: opts.personContext }).names;
    const missing = computeMissingFields({ ...input, decidedAt, topic: (topic ?? project)?.name ?? null });
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
      status: input.asDraft || missing.length > 0 ? 'draft' : (opts.status ?? 'active'),
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
  update(id: string, { patch, ...opts }: { patch: DecisionPatch; trigger?: string; actor?: 'user' | 'agent' }): Decision {
    const current = this.row(id);
    // runtime guard for internal callers as well (the IPC schema already rejects these statuses)
    assertEditableStatusChange(current.status as DecisionStatus, patch.status);
    const personContext = mentionContext(opts.trigger, 'decision');
    const set: Partial<DecisionRow> = { updatedAt: nowIso(), ...this.patchColumns(current, { patch, personContext }) };
    const merged = { ...current, ...set };
    const missing = computeMissingFields({
      ...merged,
      topic: this.graph.getEntity(merged.topicId ?? merged.projectId ?? '')?.name ?? null,
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
    const changed = trackedChanges(current, set);
    this.audit.log({
      action: 'decision.update',
      actor: opts.actor ?? 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: current.title, status: current.status, decidedAt: current.decidedAt, ...changed.before },
      after: { status: set.status ?? current.status, missing, ...changed.after },
      undo: { type: DECISION_UPDATE_UNDO_TYPE, data: undoData },
    });
    void this.reindex(id);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return this.get(id);
  }

  /** Adds a document as a further source of the decision (instead of recording it twice); nothing changes when it already is one. */
  addSource(id: string, { sourceId, ...origin }: { sourceId: string; actor?: 'user' | 'agent'; trigger?: string }): Decision {
    if (this.row(id).sourceIds.includes(sourceId)) return this.get(id);
    return this.update(id, { patch: { sourceIds: [sourceId] }, ...origin });
  }

  /** A still relevant decision with the same text on the same topic. */
  findDuplicate(candidate: { decisionText: string; topic?: string | null }): Decision | undefined {
    return findDecisionDuplicate(candidate, this.list());
  }

  /** The patch's columns; the date is checked before topics, projects and persons are created. */
  private patchColumns(current: DecisionRow, { patch, personContext }: { patch: DecisionPatch; personContext: PersonMentionContext }): Partial<DecisionRow> {
    const set: Partial<DecisionRow> = {};
    if (patch.decidedAt !== undefined) set.decidedAt = checkedDecisionDate(patch.decidedAt, today());
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.graph.ensureEntity({ type: 'topic', name: patch.topic }).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.graph.ensureEntity({ type: 'project', name: patch.project }).id : null;
    if (patch.participants !== undefined) set.participants = this.persons.resolveNames(patch.participants, { context: personContext }).names;
    return { ...plainPatchColumns(current, patch), ...set };
  }

  private syncGraph(row: DecisionRow, personContext: PersonMentionContext): void {
    const link = { confidence: row.confidence, status: 'confirmed' as const, sourceIds: row.sourceIds };
    this.graph.registerNode({ type: 'decision', id: row.id, name: row.title, description: row.decisionText });
    if (row.topicId) this.graph.link({ sourceId: row.id, targetId: row.topicId, relationType: 'concerns' }, link);
    if (row.projectId) this.graph.link({ sourceId: row.id, targetId: row.projectId, relationType: 'affects' }, link);
    const personIds: string[] = [];
    for (const person of this.persons.resolveNames(row.participants, { context: personContext }).entities) {
      personIds.push(person.id);
      this.graph.link({ sourceId: person.id, targetId: row.id, relationType: 'participated_in' }, link);
    }
    // relations to a previous topic, project or participant no longer apply
    this.graph.unlinkSystemRelations({ entityId: row.id, relationType: 'concerns', keepIds: row.topicId ? [row.topicId] : [], otherType: 'topic' });
    this.graph.unlinkSystemRelations({ entityId: row.id, relationType: 'affects', keepIds: row.projectId ? [row.projectId] : [], otherType: 'project' });
    this.graph.unlinkSystemRelations({ entityId: row.id, relationType: 'participated_in', keepIds: personIds, direction: 'in', otherType: 'person' });
    for (const sourceId of row.sourceIds) {
      if (this.graph.getEntity(sourceId)?.type === 'document')
        this.graph.link(
          { sourceId, targetId: row.id, relationType: 'supports' },
          { confidence: Math.min(row.confidence, 0.8), status: 'proposed', sourceIds: [sourceId] },
        );
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
  supersede(request: { oldId: string; newId: string; confirmed: boolean; trigger?: string }): { old: Decision; new: Decision } {
    return this.lifecycle.supersede(request);
  }

  revoke(id: string, opts: { confirmed: boolean; trigger?: string }): Decision {
    return this.lifecycle.revoke(id, opts);
  }

  /** Deletes a draft or unclear decision (created in error); returns the audit entry whose undo brings it back. */
  delete(id: string, opts: { confirmed: boolean; trigger?: string }): string {
    return this.lifecycle.delete(id, opts);
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
