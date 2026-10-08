import { localDate, localToday, OpenItemSolution, type OpenItem, type OpenItemInput, type OpenItemPatch, type OpenItemStatus } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities, messages, openItems, reminders } from '../db/schema';
import { syncReminderAt } from './reminders';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput } from '../util/dates';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';
import { assertEditableStatusChange, newOpenItemRow, openItemIndexContent, plainPatchColumns, toOpenItem, type OpenItemRow } from './open-item-fields';
import { ACTIVE_STATUSES, countOpenItemRows, openItemRows, type OpenItemFilter } from './open-item-list';
import { deleteOpenItem } from './open-item-delete';
import { matchOpenItems, type HintMatch } from './open-item-matching';
import {
  OPEN_ITEM_STATUS_UNDO_TYPE,
  OPEN_ITEM_UPDATE_UNDO_TYPE,
  registerOpenItemUndo,
  type OpenItemStatusUndo,
  type OpenItemUpdateUndo,
} from './open-item-undo';
import { mentionContext, type PersonService } from './persons';
import { previousValues } from './previous-values';
import type { SearchService } from './search';
import type { UndoService } from './undo';

export { detectOpenItemSentences, hintTokens, matchOpenItems } from './open-item-matching';

export { ACTIVE_STATUSES };

type Origin = { actor?: 'user' | 'agent'; trigger?: string };

export interface OpenItemServiceDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  persons: PersonService;
  search: SearchService;
  audit: AuditService;
  undo: UndoService;
}

/** Open items (tasks/questions) including responsible person, due date and status. */
export class OpenItemService {
  constructor(private readonly deps: OpenItemServiceDeps) {
    const { ctx, graph, undo } = deps;
    registerOpenItemUndo(undo, { ctx, graph, reindex: (id) => this.reindex(id) });
  }

  private get db() {
    return this.deps.ctx.database.db;
  }

  private row(id: string): OpenItemRow {
    const row = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    return row;
  }

  /** Chat messages among the sources → conversation (to jump back from the open item into the chat). */
  private conversationsOf(rows: OpenItemRow[]): Map<string, string> {
    const ids = [...new Set(rows.flatMap((row) => row.sourceIds))];
    if (!ids.length) return new Map();
    return new Map(
      this.db
        .select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .where(inArray(messages.id, ids))
        .all()
        .map((message) => [message.id, message.conversationId]),
    );
  }

  private map(row: OpenItemRow, lookups: { names?: Map<string, string>; conversations?: Map<string, string> } = {}): OpenItem {
    const nameOf = (id: string | null) => (id ? (lookups.names?.get(id) ?? this.deps.graph.getEntity(id)?.name ?? null) : null);
    return toOpenItem(row, { nameOf, conversations: lookups.conversations ?? this.conversationsOf([row]) });
  }

  private mapMany(rows: OpenItemRow[]): OpenItem[] {
    const ids = [...new Set(rows.flatMap((row) => [row.topicId, row.projectId, row.responsiblePersonId]).filter((id): id is string => Boolean(id)))];
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
    const conversations = this.conversationsOf(rows);
    return rows.map((row) => this.map(row, { names, conversations }));
  }

  get(id: string): OpenItem {
    return this.map(this.row(id));
  }

  /** Newest first; without `limit` all matching items (internal callers), the IPC channel always pages. */
  list(opts: OpenItemFilter & { limit?: number; offset?: number } = {}): OpenItem[] {
    return this.mapMany(openItemRows(this.db, opts));
  }

  count(filter: OpenItemFilter = {}): number {
    return countOpenItemRows(this.db, filter);
  }

  /** Finds an active open item by a hint – only on an unambiguous hit. */
  findByHint(hint: string): OpenItem | null {
    const match = this.matchByHint(hint);
    return match.status === 'match' ? match.item : null;
  }

  /** Hit, ambiguous (several close together) or none – see matchOpenItems. */
  matchByHint(hint: string): HintMatch {
    return matchOpenItems({ hint, items: this.list({ onlyActive: true }) });
  }

  /** The responsible person as a `responsible_for` relation; a relation to a former responsible person becomes outdated (#274). */
  private syncResponsible(id: string, { personId, sourceIds }: { personId: string | null; sourceIds: string[] }): void {
    if (personId)
      this.deps.graph.link({ sourceId: personId, targetId: id, relationType: 'responsible_for' }, { confidence: 0.9, status: 'confirmed', sourceIds });
    this.deps.graph.unlinkSystemRelations({
      entityId: id,
      relationType: 'responsible_for',
      keepIds: personId ? [personId] : [],
      direction: 'in',
      otherType: 'person',
    });
  }

  create(input: OpenItemInput, origin: Origin = {}): OpenItem {
    const row = this.newRow(input, origin);
    this.db.transaction(() => {
      const link = { confidence: row.confidence, status: 'confirmed' as const, sourceIds: row.sourceIds };
      this.db.insert(openItems).values(row).run();
      this.deps.graph.registerNode({ type: 'task', id: row.id, name: row.title, description: row.description });
      if (row.topicId) this.deps.graph.link({ sourceId: row.id, targetId: row.topicId, relationType: 'relates_to' }, link);
      if (row.projectId) this.deps.graph.link({ sourceId: row.id, targetId: row.projectId, relationType: 'belongs_to' }, link);
      this.syncResponsible(row.id, { personId: row.responsiblePersonId, sourceIds: row.sourceIds });
      for (const sourceId of row.sourceIds) this.linkSource(row.id, { sourceId, confidence: row.confidence });
    });
    this.deps.audit.log({
      action: 'open_item.create',
      actor: origin.actor ?? 'user',
      trigger: origin.trigger ?? 'manual',
      confirmed: true,
      entityIds: [row.id],
      after: { title: row.title, dueAt: row.dueAt },
    });
    this.deps.ctx.events.created({ id: row.id, type: 'task' });
    void this.reindex(row.id);
    this.deps.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(row.id);
  }

  private newRow(input: OpenItemInput, origin: Origin): OpenItemRow {
    const now = nowIso();
    const topic = input.topic?.trim() ? this.deps.graph.ensureEntity({ type: 'topic', name: input.topic }) : null;
    const project = input.project?.trim() ? this.deps.graph.ensureEntity({ type: 'project', name: input.project }) : null;
    const person = input.responsible?.trim()
      ? this.deps.persons.resolve(input.responsible, { context: mentionContext(origin.trigger, 'open_item') }).entity
      : null;
    return newOpenItemRow(input, { id: newId(), now, topicId: topic?.id ?? null, projectId: project?.id ?? null, responsiblePersonId: person?.id ?? null });
  }

  /** Partial update of the fields in `patch`; closing needs `close()` with confirmation, reopening goes through undo. */
  update(id: string, { patch, ...opts }: { patch: OpenItemPatch; trigger?: string }): OpenItem {
    const current = this.row(id);
    // runtime guard for internal callers as well (the IPC schema already rejects these statuses)
    assertEditableStatusChange(current.status as OpenItemStatus, patch.status);
    const set: Partial<OpenItemRow> = { updatedAt: nowIso(), ...this.patchColumns(current, { patch, trigger: opts.trigger }) };
    const { changes } = this.deps.graph.trackRelationChanges(id, () =>
      this.db.transaction(() => {
        this.db.update(openItems).set(set).where(eq(openItems.id, id)).run();
        this.syncEditedGraph(current, set);
      }),
    );
    const undoData: OpenItemUpdateUndo = { id, before: previousValues(current, set), afterUpdatedAt: set.updatedAt!, relations: changes };
    this.deps.audit.log({
      action: 'open_item.update',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: current.status, dueAt: current.dueAt },
      after: patch,
      undo: { type: OPEN_ITEM_UPDATE_UNDO_TYPE, data: undoData },
    });
    void this.reindex(id);
    this.deps.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(id);
  }

  private patchColumns(current: OpenItemRow, { patch, trigger }: { patch: OpenItemPatch; trigger?: string }): Partial<OpenItemRow> {
    const set = plainPatchColumns(current, patch);
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.deps.graph.ensureEntity({ type: 'topic', name: patch.topic }).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.deps.graph.ensureEntity({ type: 'project', name: patch.project }).id : null;
    if (patch.responsible !== undefined) Object.assign(set, this.responsibleColumns(patch.responsible, trigger));
    if (patch.responsibleUnknown !== undefined) set.responsibleUnknown = patch.responsibleUnknown;
    if (patch.dueUnknown !== undefined) set.dueUnknown = patch.dueUnknown;
    return set;
  }

  /** A pronoun or answer word ("ja", "unbekannt") is not a person and leaves the responsible person unchanged. */
  private responsibleColumns(responsible: string | null, trigger: string | undefined): Partial<OpenItemRow> {
    const resolved = responsible?.trim() ? this.deps.persons.resolve(responsible, { context: mentionContext(trigger, 'open_item') }) : null;
    if (resolved?.rejected) return {};
    const personId = resolved?.entity?.id ?? null;
    return personId ? { responsiblePersonId: personId, responsibleUnknown: false } : { responsiblePersonId: null };
  }

  /** Graph after an edit: the previous topic, project or responsible person no longer applies. */
  private syncEditedGraph(current: OpenItemRow, set: Partial<OpenItemRow>): void {
    const id = current.id;
    if (set.title) this.deps.graph.registerNode({ type: 'task', id, name: set.title, description: set.description ?? current.description });
    if (set.topicId) this.deps.graph.link({ sourceId: id, targetId: set.topicId, relationType: 'relates_to' }, { confidence: 0.9, status: 'confirmed' });
    if (set.projectId) this.deps.graph.link({ sourceId: id, targetId: set.projectId, relationType: 'belongs_to' }, { confidence: 0.9, status: 'confirmed' });
    if (set.topicId !== undefined)
      this.deps.graph.unlinkSystemRelations({ entityId: id, relationType: 'relates_to', keepIds: set.topicId ? [set.topicId] : [], otherType: 'topic' });
    if (set.projectId !== undefined)
      this.deps.graph.unlinkSystemRelations({ entityId: id, relationType: 'belongs_to', keepIds: set.projectId ? [set.projectId] : [], otherType: 'project' });
    if (set.responsiblePersonId !== undefined) this.syncResponsible(id, { personId: set.responsiblePersonId, sourceIds: current.sourceIds });
  }

  /** Links a source (decision or document) with the item in the graph: item → results_from → source. */
  private linkSource(id: string, { sourceId, confidence }: { sourceId: string; confidence: number }): void {
    const type = this.deps.graph.getEntity(sourceId)?.type;
    if (type === 'decision' || type === 'document')
      this.deps.graph.link({ sourceId: id, targetId: sourceId, relationType: 'results_from' }, { confidence, status: 'confirmed', sourceIds: [sourceId] });
  }

  /** Adds a source where the same item was detected again; missing details are filled in from it, existing ones stay. */
  addSource(
    id: string,
    {
      sourceId,
      extra = {},
      origin = {},
    }: { sourceId: string; extra?: { description?: string | null; dueAt?: string | null; responsible?: string | null }; origin?: Origin },
  ): OpenItem {
    const current = this.row(id);
    const set: Partial<OpenItemRow> = { updatedAt: nowIso(), ...this.missingDetails(current, extra) };
    if (!current.sourceIds.includes(sourceId)) set.sourceIds = [...current.sourceIds, sourceId];
    this.db.transaction(() => {
      this.db.update(openItems).set(set).where(eq(openItems.id, id)).run();
      if (set.description) this.deps.graph.registerNode({ type: 'task', id, name: current.title, description: set.description });
      if (set.responsiblePersonId) this.syncResponsible(id, { personId: set.responsiblePersonId, sourceIds: set.sourceIds ?? current.sourceIds });
      this.linkSource(id, { sourceId, confidence: current.confidence });
    });
    this.deps.audit.log({
      action: 'open_item.add_source',
      actor: origin.actor ?? 'user',
      trigger: origin.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id, sourceId],
      before: { sourceIds: current.sourceIds },
      after: { sourceIds: set.sourceIds ?? current.sourceIds },
    });
    void this.reindex(id);
    this.deps.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(id);
  }

  private missingDetails(
    current: OpenItemRow,
    extra: { description?: string | null; dueAt?: string | null; responsible?: string | null },
  ): Partial<OpenItemRow> {
    const set: Partial<OpenItemRow> = {};
    if (!current.description && extra.description?.trim()) set.description = extra.description.trim();
    if (!current.dueAt && extra.dueAt) {
      set.dueAt = normalizeDateInput(extra.dueAt);
      if (set.dueAt) set.dueUnknown = false;
    }
    const responsible =
      !current.responsiblePersonId && extra.responsible?.trim() ? this.deps.persons.resolve(extra.responsible, { context: 'open_item' }).entity : null;
    if (responsible) {
      set.responsiblePersonId = responsible.id;
      set.responsibleUnknown = false;
    }
    return set;
  }

  /** Stores the (latest) solution proposal on the item; an existing one is replaced. */
  setSolution(id: string, solution: OpenItemSolution): OpenItem {
    const found = this.db.select({ id: openItems.id }).from(openItems).where(eq(openItems.id, id)).get();
    if (!found) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    this.db
      .update(openItems)
      .set({ solution: OpenItemSolution.parse(solution), updatedAt: nowIso() })
      .where(eq(openItems.id, id))
      .run();
    this.deps.ctx.events.changed('openItems');
    return this.get(id);
  }

  /** Stage 2: closing only with explicit confirmation and an undo entry; `resolutionNote` says how it was solved or why dropped. */
  close(id: string, { status, ...opts }: { status: 'resolved' | 'dismissed'; confirmed: boolean; trigger?: string; resolutionNote?: string | null }): OpenItem {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Schließen eines offenen Punkts erfordert eine ausdrückliche Bestätigung.');
    const current = this.row(id);
    const updatedAt = nowIso();
    const resolutionNote = opts.resolutionNote?.trim() || null;
    // open reminders of the item end with it (undo restores them)
    const ended = this.db
      .select({ id: reminders.id, status: reminders.status })
      .from(reminders)
      .where(and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, id), inArray(reminders.status, ['pending', 'fired'])))
      .all();
    this.db.transaction(() => {
      this.db.update(openItems).set({ status, updatedAt, resolutionNote }).where(eq(openItems.id, id)).run();
      for (const reminder of ended) this.db.update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, reminder.id)).run();
      syncReminderAt(this.db, id);
    });
    const undoData: OpenItemStatusUndo = {
      id,
      previousStatus: current.status as OpenItemStatus,
      previousNote: current.resolutionNote,
      afterUpdatedAt: updatedAt,
      reminders: ended,
    };
    this.deps.audit.log({
      action: 'open_item.close',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: current.status },
      after: { status, resolutionNote },
      undo: { type: OPEN_ITEM_STATUS_UNDO_TYPE, data: undoData },
    });
    void this.reindex(id);
    this.deps.ctx.events.changed('openItems', 'status', 'reminders');
    return this.get(id);
  }

  delete(id: string, opts: { confirmed: boolean }): void {
    deleteOpenItem(this.deps, id, opts);
  }

  /** Active items due before `today` (local calendar day, #77). */
  overdue(today = localToday()): OpenItem[] {
    return this.list({ onlyActive: true }).filter((item) => item.dueAt && localDate(item.dueAt) < today);
  }

  /** Active items due from `today` through `days` days ahead (local calendar days), i.e. „Bald fällig“. */
  dueSoon(days: number, now = new Date()): OpenItem[] {
    const today = localToday(now);
    const until = new Date(now);
    until.setDate(until.getDate() + days);
    const last = localDate(until);
    return this.list({ onlyActive: true }).filter((item) => {
      if (!item.dueAt) return false;
      const due = localDate(item.dueAt);
      return due >= today && due <= last;
    });
  }

  /** Rebuilds the search index entry (e.g. after a merge changed names or references). */
  async reindex(id: string): Promise<void> {
    try {
      const item = this.get(id);
      await this.deps.search.index({ type: 'task', id, title: item.title, content: openItemIndexContent(item) });
    } catch (err) {
      this.deps.ctx.logger.warn('open-items', 'Indexing failed', { error: err });
    }
  }
}
