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

/** Dated events („habe am 01.10.2026 beim German Testing Day eingereicht“): a type of their own, shown in the timeline, search and knowledge graph. */
export class EventService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
    private readonly persons: PersonService,
    undo: UndoService,
  ) {
    undo.register('event_update', {
      check: async (data) => {
        const d = data as EventUpdateUndo;
        const row = this.db.select().from(events).where(eq(events.id, d.id)).get();
        if (!row) return ['Das Ereignis existiert nicht mehr.'];
        const conflicts = row.updatedAt === d.afterUpdatedAt ? [] : ['Das Ereignis wurde seit der Bearbeitung verändert.'];
        return [...conflicts, ...this.graph.relationChangeConflicts(d.relations)];
      },
      run: async (data) => {
        const d = data as EventUpdateUndo;
        this.db.transaction(() => {
          this.db
            .update(events)
            .set({ ...d.before, updatedAt: nowIso() })
            .where(eq(events.id, d.id))
            .run();
          const row = this.db.select().from(events).where(eq(events.id, d.id)).get();
          if (row) this.graph.registerNode('event', row.id, row.title, row.description);
          this.graph.revertRelationChanges(d.relations);
        });
        void this.reindex(d.id);
        this.ctx.events.changed('events', 'knowledge', 'status');
        return 'Bearbeitung des Ereignisses rückgängig gemacht.';
      },
    });
    undo.register('event_delete', {
      check: async (data) => {
        const d = data as EventDeleteUndo;
        return this.db.select({ id: events.id }).from(events).where(eq(events.id, d.event.id)).get() ? ['Das Ereignis ist bereits wiederhergestellt.'] : [];
      },
      run: async (data) => this.restore(data as EventDeleteUndo),
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  private map(r: Row, names?: Map<string, string>): EventRecord {
    const nm = (id: string | null) => (id ? (names?.get(id) ?? this.graph.getEntity(id)?.name ?? null) : null);
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      occurredAt: r.occurredAt,
      topicId: r.topicId,
      topicName: nm(r.topicId),
      projectId: r.projectId,
      projectName: nm(r.projectId),
      participants: r.participants,
      sourceIds: r.sourceIds,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      duplicateOfId: r.duplicateOfId,
    };
  }

  get(id: string): EventRecord {
    const r = this.db.select().from(events).where(eq(events.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    return this.map(r);
  }

  list(opts: { topicId?: string; projectId?: string } = {}): EventRecord[] {
    // a further topic/project counts as well (#287)
    const subject = opts.topicId ?? opts.projectId;
    const extra = new Set(
      subject
        ? (
            this.ctx.database.sqlite
              .prepare(`SELECT source_entity_id AS id FROM relations WHERE target_entity_id = ? AND status = 'confirmed'`)
              .all(subject) as Array<{
              id: string;
            }>
          ).map((r) => r.id)
        : [],
    );
    const rows = this.db
      .select()
      .from(events)
      .orderBy(desc(events.occurredAt))
      .all()
      .filter(
        (r) => (!opts.topicId || r.topicId === opts.topicId || extra.has(r.id)) && (!opts.projectId || r.projectId === opts.projectId || extra.has(r.id)),
      );
    const ids = [...new Set(rows.flatMap((r) => [r.topicId, r.projectId]).filter((x): x is string => Boolean(x)))];
    const names = new Map(
      ids.length
        ? this.db
            .select({ id: entities.id, name: entities.name })
            .from(entities)
            .where(inArray(entities.id, ids))
            .all()
            .map((e) => [e.id, e.name])
        : [],
    );
    return rows.map((r) => this.map(r, names));
  }

  create(input: EventInput, ctxInfo: { actor?: 'user' | 'agent'; trigger?: string } = {}): EventRecord {
    const occurredAt = normalizeDateInput(input.occurredAt ?? null);
    if (!occurredAt) throw new AppError('validation_error', 'Für ein Ereignis wird ein gültiges Datum benötigt.');
    const now = nowIso();
    const topic = input.topic?.trim() ? this.graph.ensureEntity('topic', input.topic) : null;
    const project = input.project?.trim() ? this.graph.ensureEntity('project', input.project) : null;
    const personContext = mentionContext(ctxInfo.trigger, 'manual');
    const row: Row = {
      id: newId(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      occurredAt,
      topicId: topic?.id ?? null,
      projectId: project?.id ?? null,
      participants: this.persons.resolveNames(input.participants ?? [], { context: personContext }).names,
      sourceIds: input.sourceIds ?? [],
      createdAt: now,
      updatedAt: now,
      duplicateOfId: null,
    };
    this.db.transaction(() => {
      this.db.insert(events).values(row).run();
      this.graph.registerNode('event', row.id, row.title, row.description);
      if (topic) this.graph.link(row.id, topic.id, 'relates_to', { confidence: 0.9, status: 'confirmed', sourceIds: row.sourceIds });
      if (project) this.graph.link(row.id, project.id, 'belongs_to', { confidence: 0.9, status: 'confirmed', sourceIds: row.sourceIds });
      this.syncParticipants(row, personContext);
    });
    this.audit.log({
      action: 'event.create',
      actor: ctxInfo.actor ?? 'user',
      trigger: ctxInfo.trigger ?? 'manual',
      confirmed: true,
      entityIds: [row.id],
      after: { title: row.title, occurredAt },
    });
    this.ctx.events.created({ id: row.id, type: 'event' });
    void this.reindex(row.id);
    this.ctx.events.changed('events', 'knowledge', 'status');
    return this.get(row.id);
  }

  /** Finds an event with the same (normalised) title on the same day (events discarded as duplicates do not count). */
  findIdentical(title: string, occurredAt: string): EventRecord | undefined {
    const day = normalizeDateInput(occurredAt)?.slice(0, 10);
    const norm = normalizeName(title);
    if (!day || !norm) return undefined;
    const hit = this.db
      .select()
      .from(events)
      .where(like(events.occurredAt, `${day}%`))
      .all()
      .find((r) => !r.duplicateOfId && normalizeName(r.title) === norm);
    return hit ? this.map(hit) : undefined;
  }

  /** Like `create`, but returns an identical existing event (same title, same day) instead of a duplicate. */
  createUnlessExists(input: EventInput, ctxInfo: { actor?: 'user' | 'agent'; trigger?: string } = {}): { event: EventRecord; created: boolean } {
    const existing = this.findIdentical(input.title, input.occurredAt);
    return existing ? { event: existing, created: false } : { event: this.create(input, ctxInfo), created: true };
  }

  /** The participants as `participated_in` relations; relations to persons no longer listed become outdated. */
  private syncParticipants(r: Pick<Row, 'id' | 'participants' | 'sourceIds'>, personContext: PersonMentionContext): void {
    const personIds: string[] = [];
    for (const person of this.persons.resolveNames(r.participants, { context: personContext }).entities) {
      personIds.push(person.id);
      this.graph.link(person.id, r.id, 'participated_in', { confidence: 0.9, status: 'confirmed', sourceIds: r.sourceIds });
    }
    this.graph.unlinkSystemRelations(r.id, 'participated_in', personIds, { direction: 'in', otherType: 'person' });
  }

  update(id: string, patch: Partial<EventInput>, ctxInfo: { trigger?: string } = {}): EventRecord {
    const cur = this.db.select().from(events).where(eq(events.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    const set: Partial<Row> = { updatedAt: nowIso() };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.occurredAt !== undefined) {
      const d = normalizeDateInput(patch.occurredAt);
      if (!d) throw new AppError('validation_error', 'Ungültiges Datum.');
      set.occurredAt = d;
    }
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.graph.ensureEntity('topic', patch.topic).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.graph.ensureEntity('project', patch.project).id : null;
    const personContext = mentionContext(ctxInfo.trigger, 'manual');
    if (patch.participants !== undefined) set.participants = this.persons.resolveNames(patch.participants, { context: personContext }).names;
    const { changes } = this.graph.trackRelationChanges(id, () =>
      this.db.transaction(() => {
        this.db.update(events).set(set).where(eq(events.id, id)).run();
        if (set.participants) this.syncParticipants({ ...cur, ...set }, personContext);
        this.graph.registerNode('event', id, set.title ?? cur.title, set.description === undefined ? cur.description : set.description);
        if (set.topicId) this.graph.link(id, set.topicId, 'relates_to', { confidence: 0.9, status: 'confirmed' });
        if (set.projectId) this.graph.link(id, set.projectId, 'belongs_to', { confidence: 0.9, status: 'confirmed' });
        // the previous topic/project no longer applies
        if (set.topicId !== undefined) this.graph.unlinkSystemRelations(id, 'relates_to', set.topicId ? [set.topicId] : [], { otherType: 'topic' });
        if (set.projectId !== undefined) this.graph.unlinkSystemRelations(id, 'belongs_to', set.projectId ? [set.projectId] : [], { otherType: 'project' });
      }),
    );
    const before = Object.fromEntries(Object.keys(set).flatMap((k) => (k === 'updatedAt' ? [] : [[k, cur[k as keyof Row]]]))) as Partial<Row>;
    const undoData: EventUpdateUndo = { id, before, afterUpdatedAt: set.updatedAt!, relations: changes };
    this.audit.log({
      action: 'event.update',
      actor: 'user',
      trigger: ctxInfo.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: cur.title, occurredAt: cur.occurredAt },
      after: patch,
      undo: { type: 'event_update', data: undoData },
    });
    void this.reindex(id);
    this.ctx.events.changed('events', 'knowledge', 'status');
    return this.get(id);
  }

  delete(id: string, opts: { confirmed: boolean }): void {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Löschen eines Ereignisses erfordert eine ausdrückliche Bestätigung.');
    const cur = this.db.select().from(events).where(eq(events.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    const undoData: EventDeleteUndo = { event: cur, node: this.graph.snapshotNode(id) };
    this.db.transaction(() => {
      this.db.delete(events).where(eq(events.id, id)).run();
      this.graph.removeNode(id);
    });
    this.search.remove(id);
    this.audit.log({
      action: 'event.delete',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: cur.title, occurredAt: cur.occurredAt },
      undo: { type: 'event_delete', data: undoData },
    });
    this.ctx.events.changed('events', 'knowledge', 'status');
  }

  /** Undo of `delete`: restores the event with its id, graph node, relations and search entry. */
  private restore(d: EventDeleteUndo): string {
    const exists = (entityId: string | null) => (entityId && this.graph.getEntity(entityId) ? entityId : null);
    const keptEvent = d.event.duplicateOfId && this.db.select({ id: events.id }).from(events).where(eq(events.id, d.event.duplicateOfId)).get();
    const row: Row = {
      ...d.event,
      topicId: exists(d.event.topicId),
      projectId: exists(d.event.projectId),
      duplicateOfId: keptEvent ? d.event.duplicateOfId : null,
    };
    let skipped = 0;
    this.db.transaction(() => {
      this.db.insert(events).values(row).run();
      if (d.node) skipped = this.graph.restoreNode(d.node);
      else this.graph.registerNode('event', row.id, row.title, row.description);
    });
    void this.reindex(row.id);
    this.ctx.events.changed('events', 'knowledge', 'status');
    const lost = [
      d.event.topicId && !row.topicId && 'das Thema',
      d.event.projectId && !row.projectId && 'das Projekt',
      skipped > 0 && (skipped === 1 ? 'eine Verknüpfung' : `${skipped} Verknüpfungen`),
    ].filter(Boolean);
    return lost.length ? `Ereignis wiederhergestellt. Nicht wiederhergestellt, weil inzwischen entfernt: ${lost.join(', ')}.` : 'Ereignis wiederhergestellt.';
  }

  /** Rebuilds the search index entry (e.g. after a merge changed names or references); a discarded duplicate is not searchable. */
  async reindex(id: string): Promise<void> {
    try {
      const e = this.get(id);
      if (e.duplicateOfId) {
        this.search.remove(id);
        return;
      }
      await this.search.index({
        type: 'event',
        id,
        title: e.title,
        content: [
          e.title,
          e.description,
          `Datum: ${e.occurredAt.slice(0, 10)}`,
          e.topicName && `Thema: ${e.topicName}`,
          e.projectName && `Projekt: ${e.projectName}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } catch (err) {
      this.ctx.logger.warn('events', 'Indexing failed', { error: err });
    }
  }
}
