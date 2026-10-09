import type { EventInput, EventRecord } from '@archivist/shared';
import { desc, eq, inArray, like } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities, events } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput } from '../util/dates';
import { normalizeName } from '../util/text';
import type { AuditService } from './audit';
import type { KnowledgeGraphService, NodeSnapshot, RelationChangeSet } from './knowledge-graph';
import { mentionContext, type PersonMentionContext, type PersonService } from './persons';
import type { SearchService } from './search';
import type { UndoService } from './undo';

type Row = typeof events.$inferSelect;

interface EventUpdateUndo {
  id: string;
  /** Previous values of the edited columns. */
  before: Partial<Row>;
  afterUpdatedAt: string;
  relations: RelationChangeSet;
}

interface EventDeleteUndo {
  event: Row;
  /** Graph node of the event with its relations (`null` if it had none). */
  node: NodeSnapshot | null;
}

export interface EventServiceDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  search: SearchService;
  audit: AuditService;
  persons: PersonService;
  undo: UndoService;
}

/** Dated events („habe am 01.10.2026 beim German Testing Day eingereicht“): a type of their own, shown in the timeline, search and knowledge graph. */
export class EventService {
  constructor(private readonly deps: EventServiceDeps) {
    const { undo } = deps;
    undo.register('event_update', {
      check: async (data) => this.updateConflicts(data as EventUpdateUndo),
      run: async (data) => this.revertUpdate(data as EventUpdateUndo),
    });
    undo.register('event_delete', {
      check: async (data) => (this.row((data as EventDeleteUndo).event.id) ? ['Das Ereignis ist bereits wiederhergestellt.'] : []),
      run: async (data) => this.restore(data as EventDeleteUndo),
    });
  }

  private get db() {
    return this.deps.ctx.database.db;
  }

  private row(id: string): Row | undefined {
    return this.db.select().from(events).where(eq(events.id, id)).get();
  }

  private requireRow(id: string): Row {
    const row = this.row(id);
    if (!row) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    return row;
  }

  private map(row: Row, names?: Map<string, string>): EventRecord {
    const nameOf = (id: string | null) => (id ? (names?.get(id) ?? this.deps.graph.getEntity(id)?.name ?? null) : null);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      occurredAt: row.occurredAt,
      topicId: row.topicId,
      topicName: nameOf(row.topicId),
      projectId: row.projectId,
      projectName: nameOf(row.projectId),
      participants: row.participants,
      sourceIds: row.sourceIds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      duplicateOfId: row.duplicateOfId,
    };
  }

  get(id: string): EventRecord {
    return this.map(this.requireRow(id));
  }

  list(opts: { topicId?: string; projectId?: string } = {}): EventRecord[] {
    // a further topic/project counts as well (#287), and so do the subtopics (#282)
    const subject = opts.topicId ?? opts.projectId;
    const tree = new Set(subject ? this.deps.graph.subtreeOf(subject) : []);
    const further = this.deps.ctx.database.sqlite.prepare(
      `SELECT source_entity_id AS id FROM relations WHERE target_entity_id = ? AND status = 'confirmed' AND relation_type <> 'subtopic_of'`,
    );
    const extra = new Set([...tree].flatMap((subjectId) => (further.all(subjectId) as Array<{ id: string }>).map((row) => row.id)));
    const inTree = (id: string | null) => id !== null && tree.has(id);
    const rows = this.db
      .select()
      .from(events)
      .orderBy(desc(events.occurredAt))
      .all()
      .filter((row) => (!opts.topicId || inTree(row.topicId) || extra.has(row.id)) && (!opts.projectId || inTree(row.projectId) || extra.has(row.id)));
    const names = this.namesOf([...new Set(rows.flatMap((row) => [row.topicId, row.projectId]).filter((id): id is string => Boolean(id)))]);
    return rows.map((row) => this.map(row, names));
  }

  private namesOf(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.db.select({ id: entities.id, name: entities.name }).from(entities).where(inArray(entities.id, ids)).all();
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  create(input: EventInput, provenance: { actor?: 'user' | 'agent'; trigger?: string } = {}): EventRecord {
    const occurredAt = normalizeDateInput(input.occurredAt ?? null);
    if (!occurredAt) throw new AppError('validation_error', 'Für ein Ereignis wird ein gültiges Datum benötigt.');
    const now = nowIso();
    const topic = input.topic?.trim() ? this.deps.graph.ensureEntity({ type: 'topic', name: input.topic }) : null;
    const project = input.project?.trim() ? this.deps.graph.ensureEntity({ type: 'project', name: input.project }) : null;
    const personContext = mentionContext(provenance.trigger, 'manual');
    const row: Row = {
      id: newId(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      occurredAt,
      topicId: topic?.id ?? null,
      projectId: project?.id ?? null,
      participants: this.deps.persons.resolveNames(input.participants ?? [], { context: personContext }).names,
      sourceIds: input.sourceIds ?? [],
      createdAt: now,
      updatedAt: now,
      duplicateOfId: null,
    };
    this.db.transaction(() => {
      this.db.insert(events).values(row).run();
      this.deps.graph.registerNode({ type: 'event', id: row.id, name: row.title, description: row.description });
      if (topic)
        this.deps.graph.link(
          { sourceId: row.id, targetId: topic.id, relationType: 'relates_to' },
          { confidence: 0.9, status: 'confirmed', sourceIds: row.sourceIds },
        );
      if (project)
        this.deps.graph.link(
          { sourceId: row.id, targetId: project.id, relationType: 'belongs_to' },
          { confidence: 0.9, status: 'confirmed', sourceIds: row.sourceIds },
        );
      this.syncParticipants(row, personContext);
    });
    this.deps.audit.log({
      action: 'event.create',
      actor: provenance.actor ?? 'user',
      trigger: provenance.trigger ?? 'manual',
      confirmed: true,
      entityIds: [row.id],
      after: { title: row.title, occurredAt },
    });
    this.deps.ctx.events.created({ id: row.id, type: 'event' });
    void this.reindex(row.id);
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
    return this.get(row.id);
  }

  /** Finds an event with the same (normalised) title on the same day (events discarded as duplicates do not count). */
  findIdentical(title: string, occurredAt: string): EventRecord | undefined {
    const day = normalizeDateInput(occurredAt)?.slice(0, 10);
    const normalized = normalizeName(title);
    if (!day || !normalized) return undefined;
    const hit = this.db
      .select()
      .from(events)
      .where(like(events.occurredAt, `${day}%`))
      .all()
      .find((row) => !row.duplicateOfId && normalizeName(row.title) === normalized);
    return hit ? this.map(hit) : undefined;
  }

  /** Like `create`, but returns an identical existing event (same title, same day) instead of a duplicate. */
  createUnlessExists(input: EventInput, provenance: { actor?: 'user' | 'agent'; trigger?: string } = {}): { event: EventRecord; created: boolean } {
    const existing = this.findIdentical(input.title, input.occurredAt);
    return existing ? { event: existing, created: false } : { event: this.create(input, provenance), created: true };
  }

  /** The participants as `participated_in` relations; relations to persons no longer listed become outdated. */
  private syncParticipants(event: Pick<Row, 'id' | 'participants' | 'sourceIds'>, personContext: PersonMentionContext): void {
    const personIds: string[] = [];
    for (const person of this.deps.persons.resolveNames(event.participants, { context: personContext }).entities) {
      personIds.push(person.id);
      this.deps.graph.link(
        { sourceId: person.id, targetId: event.id, relationType: 'participated_in' },
        { confidence: 0.9, status: 'confirmed', sourceIds: event.sourceIds },
      );
    }
    this.deps.graph.unlinkSystemRelations({ entityId: event.id, relationType: 'participated_in', keepIds: personIds, direction: 'in', otherType: 'person' });
  }

  update(id: string, { patch, ...provenance }: { patch: Partial<EventInput>; trigger?: string }): EventRecord {
    const current = this.requireRow(id);
    const personContext = mentionContext(provenance.trigger, 'manual');
    const set = this.changesOf(patch, personContext);
    const { changes } = this.deps.graph.trackRelationChanges(id, () => this.db.transaction(() => this.applyUpdate({ current, set, personContext })));
    const before = Object.fromEntries(Object.keys(set).flatMap((key) => (key === 'updatedAt' ? [] : [[key, current[key as keyof Row]]]))) as Partial<Row>;
    const undoData: EventUpdateUndo = { id, before, afterUpdatedAt: set.updatedAt!, relations: changes };
    this.deps.audit.log({
      action: 'event.update',
      actor: 'user',
      trigger: provenance.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: current.title, occurredAt: current.occurredAt },
      after: patch,
      undo: { type: 'event_update', data: undoData },
    });
    void this.reindex(id);
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
    return this.get(id);
  }

  /** The columns a patch changes; a named topic or project is created if missing. */
  private changesOf(patch: Partial<EventInput>, personContext: PersonMentionContext): Partial<Row> {
    const set: Partial<Row> = { updatedAt: nowIso() };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.occurredAt !== undefined) {
      const occurredAt = normalizeDateInput(patch.occurredAt);
      if (!occurredAt) throw new AppError('validation_error', 'Ungültiges Datum.');
      set.occurredAt = occurredAt;
    }
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.deps.graph.ensureEntity({ type: 'topic', name: patch.topic }).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.deps.graph.ensureEntity({ type: 'project', name: patch.project }).id : null;
    if (patch.participants !== undefined) set.participants = this.deps.persons.resolveNames(patch.participants, { context: personContext }).names;
    return set;
  }

  private applyUpdate(update: { current: Row; set: Partial<Row>; personContext: PersonMentionContext }): void {
    const { current, set } = update;
    const { id } = current;
    this.db.update(events).set(set).where(eq(events.id, id)).run();
    if (set.participants) this.syncParticipants({ ...current, ...set }, update.personContext);
    this.deps.graph.registerNode({
      type: 'event',
      id,
      name: set.title ?? current.title,
      description: set.description === undefined ? current.description : set.description,
    });
    if (set.topicId) this.deps.graph.link({ sourceId: id, targetId: set.topicId, relationType: 'relates_to' }, { confidence: 0.9, status: 'confirmed' });
    if (set.projectId) this.deps.graph.link({ sourceId: id, targetId: set.projectId, relationType: 'belongs_to' }, { confidence: 0.9, status: 'confirmed' });
    // the previous topic/project no longer applies
    if (set.topicId !== undefined)
      this.deps.graph.unlinkSystemRelations({ entityId: id, relationType: 'relates_to', keepIds: set.topicId ? [set.topicId] : [], otherType: 'topic' });
    if (set.projectId !== undefined)
      this.deps.graph.unlinkSystemRelations({ entityId: id, relationType: 'belongs_to', keepIds: set.projectId ? [set.projectId] : [], otherType: 'project' });
  }

  private updateConflicts(undoData: EventUpdateUndo): string[] {
    const row = this.row(undoData.id);
    if (!row) return ['Das Ereignis existiert nicht mehr.'];
    const conflicts = row.updatedAt === undoData.afterUpdatedAt ? [] : ['Das Ereignis wurde seit der Bearbeitung verändert.'];
    return [...conflicts, ...this.deps.graph.relationChangeConflicts(undoData.relations)];
  }

  private revertUpdate(undoData: EventUpdateUndo): string {
    this.db.transaction(() => {
      this.db
        .update(events)
        .set({ ...undoData.before, updatedAt: nowIso() })
        .where(eq(events.id, undoData.id))
        .run();
      const row = this.row(undoData.id);
      if (row) this.deps.graph.registerNode({ type: 'event', id: row.id, name: row.title, description: row.description });
      this.deps.graph.revertRelationChanges(undoData.relations);
    });
    void this.reindex(undoData.id);
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
    return 'Bearbeitung des Ereignisses rückgängig gemacht.';
  }

  delete(id: string, opts: { confirmed: boolean }): void {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Löschen eines Ereignisses erfordert eine ausdrückliche Bestätigung.');
    const current = this.requireRow(id);
    const undoData: EventDeleteUndo = { event: current, node: this.deps.graph.snapshotNode(id) };
    this.db.transaction(() => {
      this.db.delete(events).where(eq(events.id, id)).run();
      this.deps.graph.removeNode(id);
    });
    this.deps.search.remove(id);
    this.deps.audit.log({
      action: 'event.delete',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: current.title, occurredAt: current.occurredAt },
      undo: { type: 'event_delete', data: undoData },
    });
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
  }

  /** Undo of `delete`: restores the event with its id, graph node, relations and search entry. */
  private restore(undoData: EventDeleteUndo): string {
    const keptEvent = undoData.event.duplicateOfId && this.row(undoData.event.duplicateOfId);
    const row: Row = {
      ...undoData.event,
      topicId: this.deps.graph.existingId(undoData.event.topicId),
      projectId: this.deps.graph.existingId(undoData.event.projectId),
      duplicateOfId: keptEvent ? undoData.event.duplicateOfId : null,
    };
    let skipped = 0;
    this.db.transaction(() => {
      this.db.insert(events).values(row).run();
      if (undoData.node) skipped = this.deps.graph.restoreNode(undoData.node);
      else this.deps.graph.registerNode({ type: 'event', id: row.id, name: row.title, description: row.description });
    });
    void this.reindex(row.id);
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
    const lost = [
      undoData.event.topicId && !row.topicId && 'das Thema',
      undoData.event.projectId && !row.projectId && 'das Projekt',
      skipped > 0 && (skipped === 1 ? 'eine Verknüpfung' : `${skipped} Verknüpfungen`),
    ].filter(Boolean);
    return lost.length ? `Ereignis wiederhergestellt. Nicht wiederhergestellt, weil inzwischen entfernt: ${lost.join(', ')}.` : 'Ereignis wiederhergestellt.';
  }

  /** Rebuilds the search index entry (e.g. after a merge changed names or references); a discarded duplicate is not searchable. */
  async reindex(id: string): Promise<void> {
    try {
      const event = this.get(id);
      if (event.duplicateOfId) {
        this.deps.search.remove(id);
        return;
      }
      await this.deps.search.index({
        type: 'event',
        id,
        title: event.title,
        content: [
          event.title,
          event.description,
          `Datum: ${event.occurredAt.slice(0, 10)}`,
          event.topicName && `Thema: ${event.topicName}`,
          event.projectName && `Projekt: ${event.projectName}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } catch (err) {
      this.deps.ctx.logger.warn('events', 'Indexing failed', { error: err });
    }
  }
}
