import type { EntityType } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, events } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import type { AuditService } from '../audit';
import type { EventService } from '../events';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NoteService } from '../notes';
import type { UndoService } from '../undo';
import type { CreatedRelation, MergeLinks } from './merge-links';
import type { EntityRow, EventRow } from './note-event-insights';
import { takeOverMissing, type TakeOver, type TakeOverRules } from './record-merge';

/** Audit undo types of {@link NoteEventMerger.mergeNotes} and {@link NoteEventMerger.mergeEvents}. */
export const NOTE_MERGE_UNDO_TYPE = 'note.merge_duplicate';
export const EVENT_MERGE_UNDO_TYPE = 'event.merge_duplicate';

/** What the kept event takes over from the duplicate. */
export const EVENT_TAKE_OVER: TakeOverRules<EventRow> = {
  description: 'append',
  topicId: 'fill',
  projectId: 'fill',
  sourceIds: 'union',
};
export const EVENT_FIELD_LABELS: Partial<Record<keyof EventRow, string>> = {
  description: 'Beschreibung',
  topicId: 'Thema',
  projectId: 'Projekt',
  sourceIds: 'Quellen',
};
/** For events, topic and project are fields (taken over as such), not free links. */
export const EVENT_FIELD_TARGETS: EntityType[] = ['topic', 'project'];

export interface RecordMergeResult {
  auditId: string;
  keepId: string;
  duplicateId: string;
  keepTitle: string;
  duplicateTitle: string;
  /** German labels of what the kept record took over (fields, „Verknüpfungen“). */
  takenOver: string[];
}

interface NoteMergeUndo {
  keepId: string;
  duplicateId: string;
  duplicateUpdatedAt: string;
  /** Missing in undo data written before it existed. */
  duplicateContent?: string;
  createdRelations: CreatedRelation[];
}

interface EventMergeUndo extends NoteMergeUndo {
  keepBefore: Partial<EventRow>;
  keepUpdatedAt: string;
  keepContent?: string;
}

/** A record apart from its timestamp: a change within the same millisecond as the merge leaves `updatedAt` as it was. */
function contentOf(row: EntityRow | EventRow): string {
  return JSON.stringify({ ...row, updatedAt: null });
}

function changedSince(row: EntityRow | EventRow, saved: { updatedAt: string; content?: string }): boolean {
  return row.updatedAt !== saved.updatedAt || (saved.content !== undefined && contentOf(row) !== saved.content);
}

type Origin = { actor?: 'user' | 'agent'; trigger?: string };
type MergeRequest = { keepId: string; duplicateId: string };

interface MergerDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  links: MergeLinks;
  notes: NoteService;
  eventRecords: EventService;
  audit: AuditService;
}

/** Merges duplicate notes and events: keeps one, takes over what it lacks and marks the other as discarded (undoable). */
export class NoteEventMerger {
  constructor(
    private readonly deps: MergerDeps,
    undo: UndoService,
  ) {
    undo.register(NOTE_MERGE_UNDO_TYPE, {
      check: async (data) => this.noteUndoConflicts(data as NoteMergeUndo),
      run: async (data) => this.undoNoteMerge(data as NoteMergeUndo),
    });
    undo.register(EVENT_MERGE_UNDO_TYPE, {
      check: async (data) => this.eventUndoConflicts(data as EventMergeUndo),
      run: async (data) => this.undoEventMerge(data as EventMergeUndo),
    });
  }

  private get db() {
    return this.deps.ctx.database.db;
  }

  entity(id: string): EntityRow | undefined {
    return this.db.select().from(entities).where(eq(entities.id, id)).get();
  }

  event(id: string): EventRow | undefined {
    return this.db.select().from(events).where(eq(events.id, id)).get();
  }

  /** Why a proposed merge can no longer be executed (record gone or already discarded), or null. */
  staleReason(kind: 'note' | 'event', { keepId, duplicateId }: MergeRequest): string | null {
    const label = kind === 'note' ? 'Notiz' : 'Ereignis';
    const lookup = (id: string) => (kind === 'note' ? this.entity(id) : this.event(id));
    const keep = lookup(keepId);
    const duplicate = lookup(duplicateId);
    if (!keep || !duplicate) return `Eines der beiden Elemente (${label}) existiert nicht mehr.`;
    const nameOf = (row: EntityRow | EventRow) => ('title' in row ? row.title : row.name);
    if (duplicate.duplicateOfId) return `Das Element „${nameOf(duplicate)}“ ist bereits als Duplikat verworfen.`;
    if (keep.duplicateOfId) return `Das Element „${nameOf(keep)}“ ist inzwischen selbst als Duplikat verworfen.`;
    return null;
  }

  /** Keeps note `keepId`, takes over the links it lacks and marks the duplicate as discarded; one undoable audit entry. */
  mergeNotes({ keepId, duplicateId }: MergeRequest, origin: Origin = {}): RecordMergeResult {
    if (keepId === duplicateId) throw new AppError('validation_error', 'Eine Notiz kann nicht mit sich selbst zusammengeführt werden.');
    const keep = this.entity(keepId);
    const duplicate = this.entity(duplicateId);
    if (keep?.type !== 'note' || duplicate?.type !== 'note') throw new AppError('validation_error', 'Notiz nicht gefunden.');
    const stale = this.staleReason('note', { keepId, duplicateId });
    if (stale) throw new AppError('validation_error', stale);
    const now = nowIso();
    const merged = this.deps.ctx.database.transaction(() => {
      const copied = this.deps.links.copyLinks({ from: duplicate.id, to: keep.id }, []);
      const createdRelations = [...copied, ...this.deps.links.markDuplicate(duplicate.id, keep.id)];
      this.db.update(entities).set({ duplicateOfId: keep.id, updatedAt: now }).where(eq(entities.id, duplicate.id)).run();
      const data: NoteMergeUndo = {
        keepId: keep.id,
        duplicateId: duplicate.id,
        duplicateUpdatedAt: now,
        duplicateContent: contentOf(this.entity(duplicate.id)!),
        createdRelations,
      };
      const auditId = this.deps.audit.log({
        action: 'note.merge_duplicate',
        actor: origin.actor ?? 'user',
        trigger: origin.trigger ?? 'manual',
        confirmed: true,
        entityIds: [keep.id, duplicate.id],
        before: { duplicate: { duplicateOfId: null } },
        after: { duplicate: { duplicateOfId: keep.id }, relations: createdRelations.map((r) => r.id) },
        undo: { type: NOTE_MERGE_UNDO_TYPE, data },
      });
      return { auditId, links: copied.length };
    });
    void this.deps.notes.reindex(duplicate.id);
    this.deps.ctx.events.changed('knowledge', 'status');
    return {
      auditId: merged.auditId,
      keepId: keep.id,
      duplicateId: duplicate.id,
      keepTitle: keep.name,
      duplicateTitle: duplicate.name,
      takenOver: merged.links ? [`${merged.links} Verknüpfung(en)`] : [],
    };
  }

  private noteUndoConflicts(undoData: NoteMergeUndo): string[] {
    const keep = this.entity(undoData.keepId);
    const duplicate = this.entity(undoData.duplicateId);
    if (!keep || !duplicate) return ['Eine der zusammengeführten Notizen existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (changedSince(duplicate, { updatedAt: undoData.duplicateUpdatedAt, content: undoData.duplicateContent }) || duplicate.duplicateOfId !== undoData.keepId)
      conflicts.push(`Die als Duplikat verworfene Notiz „${duplicate.name}“ wurde seit der Zusammenführung verändert.`);
    return [...conflicts, ...this.deps.links.createdRelationConflicts(undoData.createdRelations)];
  }

  private undoNoteMerge(undoData: NoteMergeUndo): string {
    this.deps.ctx.database.transaction(() => {
      this.db.update(entities).set({ duplicateOfId: null, updatedAt: nowIso() }).where(eq(entities.id, undoData.duplicateId)).run();
      this.deps.links.removeCreated(undoData.createdRelations);
    });
    void this.deps.notes.reindex(undoData.duplicateId);
    this.deps.ctx.events.changed('knowledge', 'status');
    return 'Zusammenführung der Notizen rückgängig gemacht.';
  }

  /** Keeps event `keepId`, takes over the details and links it lacks and marks the duplicate as discarded (undoable). */
  mergeEvents({ keepId, duplicateId }: MergeRequest, origin: Origin = {}): RecordMergeResult {
    if (keepId === duplicateId) throw new AppError('validation_error', 'Ein Ereignis kann nicht mit sich selbst zusammengeführt werden.');
    const keep = this.event(keepId);
    const duplicate = this.event(duplicateId);
    if (!keep || !duplicate) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    const stale = this.staleReason('event', { keepId, duplicateId });
    if (stale) throw new AppError('validation_error', stale);
    const takeOver = takeOverMissing({ keep, duplicate }, EVENT_TAKE_OVER);
    const merged = this.deps.ctx.database.transaction(() => this.writeEventMerge({ keep, duplicate, takeOver, origin }));
    void this.deps.eventRecords.reindex(keep.id);
    void this.deps.eventRecords.reindex(duplicate.id);
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
    const takenOver = takeOver.fields.map((field) => EVENT_FIELD_LABELS[field] ?? field);
    if (merged.links > 0) takenOver.push('Verknüpfungen');
    return { auditId: merged.auditId, keepId: keep.id, duplicateId: duplicate.id, keepTitle: keep.title, duplicateTitle: duplicate.title, takenOver };
  }

  private writeEventMerge(input: { keep: EventRow; duplicate: EventRow; takeOver: TakeOver<EventRow>; origin: Origin }): { auditId: string; links: number } {
    const { keep, duplicate, origin } = input;
    const { patch, before } = input.takeOver;
    const now = nowIso();
    this.db
      .update(events)
      .set({ ...patch, updatedAt: now })
      .where(eq(events.id, keep.id))
      .run();
    if (patch.description !== undefined) this.deps.graph.registerNode({ type: 'event', id: keep.id, name: keep.title, description: patch.description });
    const sourceIds = patch.sourceIds ?? keep.sourceIds;
    const link = { confidence: 0.9, status: 'confirmed' as const, sourceIds };
    const createdRelations: CreatedRelation[] = [
      ...(patch.topicId ? this.deps.links.linkNew({ source: keep.id, target: patch.topicId, type: 'relates_to' }, link) : []),
      ...(patch.projectId ? this.deps.links.linkNew({ source: keep.id, target: patch.projectId, type: 'belongs_to' }, link) : []),
    ];
    const copied = this.deps.links.copyLinks({ from: duplicate.id, to: keep.id }, EVENT_FIELD_TARGETS);
    createdRelations.push(...copied, ...this.deps.links.markDuplicate(duplicate.id, keep.id));
    this.db.update(events).set({ duplicateOfId: keep.id, updatedAt: now }).where(eq(events.id, duplicate.id)).run();
    this.db.update(entities).set({ duplicateOfId: keep.id, updatedAt: now }).where(eq(entities.id, duplicate.id)).run();
    const data: EventMergeUndo = {
      keepId: keep.id,
      duplicateId: duplicate.id,
      keepBefore: before,
      keepUpdatedAt: now,
      keepContent: contentOf(this.event(keep.id)!),
      duplicateUpdatedAt: now,
      duplicateContent: contentOf(this.event(duplicate.id)!),
      createdRelations,
    };
    const auditId = this.deps.audit.log({
      action: 'event.merge_duplicate',
      actor: origin.actor ?? 'user',
      trigger: origin.trigger ?? 'manual',
      confirmed: true,
      entityIds: [keep.id, duplicate.id],
      before: { keep: before, duplicate: { duplicateOfId: null } },
      after: { keep: patch, duplicate: { duplicateOfId: keep.id }, relations: createdRelations.map((r) => r.id) },
      undo: { type: EVENT_MERGE_UNDO_TYPE, data },
    });
    return { auditId, links: copied.length };
  }

  private eventUndoConflicts(undoData: EventMergeUndo): string[] {
    const keep = this.event(undoData.keepId);
    const duplicate = this.event(undoData.duplicateId);
    if (!keep || !duplicate) return ['Eines der zusammengeführten Ereignisse existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (changedSince(keep, { updatedAt: undoData.keepUpdatedAt, content: undoData.keepContent }))
      conflicts.push(`Das behaltene Ereignis „${keep.title}“ wurde seit der Zusammenführung verändert.`);
    if (changedSince(duplicate, { updatedAt: undoData.duplicateUpdatedAt, content: undoData.duplicateContent }) || duplicate.duplicateOfId !== undoData.keepId)
      conflicts.push(`Das als Duplikat verworfene Ereignis „${duplicate.title}“ wurde seit der Zusammenführung verändert.`);
    return [...conflicts, ...this.deps.links.createdRelationConflicts(undoData.createdRelations)];
  }

  private undoEventMerge(undoData: EventMergeUndo): string {
    const now = nowIso();
    this.deps.ctx.database.transaction(() => {
      this.db
        .update(events)
        .set({ ...undoData.keepBefore, updatedAt: now })
        .where(eq(events.id, undoData.keepId))
        .run();
      this.db.update(events).set({ duplicateOfId: null, updatedAt: now }).where(eq(events.id, undoData.duplicateId)).run();
      this.db.update(entities).set({ duplicateOfId: null, updatedAt: now }).where(eq(entities.id, undoData.duplicateId)).run();
      if ('description' in undoData.keepBefore) {
        const keep = this.event(undoData.keepId)!;
        this.deps.graph.registerNode({ type: 'event', id: keep.id, name: keep.title, description: keep.description });
      }
      this.deps.links.removeCreated(undoData.createdRelations);
    });
    void this.deps.eventRecords.reindex(undoData.keepId);
    void this.deps.eventRecords.reindex(undoData.duplicateId);
    this.deps.ctx.events.changed('events', 'knowledge', 'status');
    return 'Zusammenführung der Ereignisse rückgängig gemacht.';
  }
}
