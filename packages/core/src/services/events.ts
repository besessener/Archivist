import type { EventInput, EventRecord } from '@archivist/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities, events } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput } from '../util/dates';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';

type Row = typeof events.$inferSelect;

/** Datierte Ereignisse („habe am 01.10.2026 beim German Testing Day eingereicht“): eigener Typ, erscheinen in Timeline, Suche und Wissensgraph. */
export class EventService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
  ) {}

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
      sourceIds: r.sourceIds,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  get(id: string): EventRecord {
    const r = this.db.select().from(events).where(eq(events.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    return this.map(r);
  }

  list(opts: { topicId?: string; projectId?: string } = {}): EventRecord[] {
    const rows = this.db
      .select()
      .from(events)
      .orderBy(desc(events.occurredAt))
      .all()
      .filter((r) => (!opts.topicId || r.topicId === opts.topicId) && (!opts.projectId || r.projectId === opts.projectId));
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
    const row: Row = {
      id: newId(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      occurredAt,
      topicId: topic?.id ?? null,
      projectId: project?.id ?? null,
      sourceIds: input.sourceIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db.insert(events).values(row).run();
      this.graph.registerNode('event', row.id, row.title, row.description);
      if (topic) this.graph.link(row.id, topic.id, 'relates_to', { confidence: 0.9, status: 'confirmed', sourceIds: row.sourceIds });
      if (project) this.graph.link(row.id, project.id, 'belongs_to', { confidence: 0.9, status: 'confirmed', sourceIds: row.sourceIds });
    });
    this.audit.log({
      action: 'event.create',
      actor: ctxInfo.actor ?? 'user',
      trigger: ctxInfo.trigger ?? 'manual',
      confirmed: true,
      entityIds: [row.id],
      after: { title: row.title, occurredAt },
    });
    void this.reindex(row.id);
    this.ctx.events.changed('events', 'knowledge', 'status');
    return this.get(row.id);
  }

  update(id: string, patch: Partial<EventInput>): EventRecord {
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
    this.db.transaction(() => {
      this.db.update(events).set(set).where(eq(events.id, id)).run();
      this.graph.registerNode('event', id, set.title ?? cur.title, set.description === undefined ? cur.description : set.description);
      if (set.topicId) this.graph.link(id, set.topicId, 'relates_to', { confidence: 0.9, status: 'confirmed' });
      if (set.projectId) this.graph.link(id, set.projectId, 'belongs_to', { confidence: 0.9, status: 'confirmed' });
    });
    this.audit.log({
      action: 'event.update',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: cur.title, occurredAt: cur.occurredAt },
      after: patch,
    });
    void this.reindex(id);
    this.ctx.events.changed('events', 'knowledge', 'status');
    return this.get(id);
  }

  delete(id: string, opts: { confirmed: boolean }): void {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Löschen eines Ereignisses erfordert eine ausdrückliche Bestätigung.');
    const cur = this.db.select().from(events).where(eq(events.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
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
    });
    this.ctx.events.changed('events', 'knowledge', 'status');
  }

  private async reindex(id: string): Promise<void> {
    try {
      const e = this.get(id);
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
      this.ctx.logger.warn('events', 'Indexierung fehlgeschlagen', { error: err });
    }
  }
}
