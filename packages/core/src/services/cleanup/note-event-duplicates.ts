import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, events } from '../../db/schema';
import type { AuditService } from '../audit';
import type { EventService } from '../events';
import type { InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NoteService } from '../notes';
import type { UndoService } from '../undo';
import { MergeLinks } from './merge-links';
import { assessEventPair, assessNotePair, words, type EventPairAssessment, type NotePairAssessment } from './note-event-assessment';
import { eventInsight, noteInsight, noteText, type EntityRow, type EventRow } from './note-event-insights';
import { EVENT_FIELD_LABELS, EVENT_FIELD_TARGETS, EVENT_TAKE_OVER, NoteEventMerger, type RecordMergeResult } from './note-event-merge';
import { chooseKept, duplicatePairKey, takeOverMissing } from './record-merge';

/** Insight dedupe key prefixes; the key is the prefix plus the sorted ids of both records. */
export const NOTE_DUPLICATE_KEY_PREFIX = 'note-dup:';
export const EVENT_DUPLICATE_KEY_PREFIX = 'event-dup:';

/** Cheap pre-filter: notes whose word counts differ more than this cannot be duplicates (see {@link assessNotePair}). */
const MIN_SIZE_RATIO = 0.7;

export interface NoteDuplicatePair {
  keep: EntityRow;
  duplicate: EntityRow;
  assessment: NotePairAssessment;
}

export interface EventDuplicatePair {
  keep: EventRow;
  duplicate: EventRow;
  assessment: EventPairAssessment;
}

type Origin = { actor?: 'user' | 'agent'; trigger?: string };

function chooseKeptNote(a: EntityRow, b: EntityRow): { keep: EntityRow; duplicate: EntityRow } {
  const lengthA = words(noteText(a)).length;
  const lengthB = words(noteText(b)).length;
  if (lengthA === lengthB) return chooseKept(a, b);
  return lengthA > lengthB ? { keep: a, duplicate: b } : { keep: b, duplicate: a };
}

/** Both notes filed under topics/projects, but under different ones: not the same note. */
const filedApart = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && ![...a].some((subject) => b.has(subject));

/** Duplicate notes and events: the archive check proposes a merge as an insight; „Verschieden“ is remembered via its key. */
export class NoteEventDuplicateService {
  private readonly links: MergeLinks;
  private readonly merger: NoteEventMerger;

  constructor(
    private readonly ctx: AppContext,
    graph: KnowledgeGraphService,
    notes: NoteService,
    eventRecords: EventService,
    audit: AuditService,
    undo: UndoService,
    private readonly insights: InsightService,
  ) {
    this.links = new MergeLinks(ctx, graph);
    this.merger = new NoteEventMerger({ ctx, graph, links: this.links, notes, eventRecords, audit }, undo);
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Pairs of notes (not discarded) that look like duplicates; `keep` is the more complete one (on a tie the older one). */
  findNotePairs(): NoteDuplicatePair[] {
    const notes = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, 'note'), isNull(entities.duplicateOfId)))
      .all()
      .map((note) => ({ note, size: words(noteText(note)).length }))
      .sort((x, y) => x.size - y.size);
    const subjects = new Map(notes.map(({ note }) => [note.id, this.contextLinks(note.id)]));
    const pairs: NoteDuplicatePair[] = [];
    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        // sorted by length: from here on the other notes have far more words, so none can be the same note
        if (notes[i]!.size < notes[j]!.size * MIN_SIZE_RATIO) break;
        const a = notes[i]!.note;
        const b = notes[j]!.note;
        const assessment = assessNotePair(noteText(a), noteText(b));
        if (assessment.duplicate && !filedApart(subjects.get(a.id)!, subjects.get(b.id)!)) pairs.push({ ...chooseKeptNote(a, b), assessment });
      }
    }
    return pairs;
  }

  /** Pairs of events (not discarded) on the same day with similar titles; `keep` is the event recorded first. */
  findEventPairs(): EventDuplicatePair[] {
    const byDay = new Map<string, EventRow[]>();
    for (const event of this.db.select().from(events).where(isNull(events.duplicateOfId)).all())
      byDay.set(event.occurredAt.slice(0, 10), [...(byDay.get(event.occurredAt.slice(0, 10)) ?? []), event]);
    const pairs: EventDuplicatePair[] = [];
    for (const list of byDay.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const assessment = assessEventPair(list[i]!, list[j]!);
          if (assessment.duplicate) pairs.push({ ...chooseKept(list[i]!, list[j]!), assessment });
        }
      }
    }
    return pairs;
  }

  /** Topics and projects a note is linked to (active relations). */
  private contextLinks(noteId: string): Set<string> {
    const others = this.links.activeRelations(noteId).map((r) => (r.sourceEntityId === noteId ? r.targetEntityId : r.sourceEntityId));
    if (!others.length) return new Set();
    return new Set(
      this.db
        .select({ id: entities.id })
        .from(entities)
        .where(and(inArray(entities.id, others), inArray(entities.type, EVENT_FIELD_TARGETS)))
        .all()
        .map((entity) => entity.id),
    );
  }

  /** Archive check step: one merge insight per duplicate pair; gone causes are removed, „Verschieden“ stays remembered. */
  check(count?: (kind: string) => void): void {
    const noteKeys = new Set<string>();
    for (const { keep, duplicate, assessment } of this.findNotePairs()) {
      const key = duplicatePairKey(NOTE_DUPLICATE_KEY_PREFIX, [keep.id, duplicate.id]);
      noteKeys.add(key);
      const missingLinks = this.links.missingLinks({ from: duplicate.id, to: keep.id }, []).length;
      const shown = this.insights.upsert(noteInsight({ keep, duplicate, assessment, key, missingLinks }));
      if (shown.status === 'open') count?.('duplicate_note');
    }
    const eventKeys = new Set<string>();
    for (const { keep, duplicate, assessment } of this.findEventPairs()) {
      const key = duplicatePairKey(EVENT_DUPLICATE_KEY_PREFIX, [keep.id, duplicate.id]);
      eventKeys.add(key);
      const shown = this.insights.upsert(eventInsight({ keep, duplicate, assessment, key, takenOver: this.eventTakeOver(keep, duplicate) }));
      if (shown.status === 'open') count?.('duplicate_event');
    }
    for (const key of this.rememberedDifferent(NOTE_DUPLICATE_KEY_PREFIX, (id) => this.merger.entity(id)?.type === 'note')) noteKeys.add(key);
    for (const key of this.rememberedDifferent(EVENT_DUPLICATE_KEY_PREFIX, (id) => Boolean(this.merger.event(id)))) eventKeys.add(key);
    this.insights.reconcile(NOTE_DUPLICATE_KEY_PREFIX, noteKeys);
    this.insights.reconcile(EVENT_DUPLICATE_KEY_PREFIX, eventKeys);
  }

  private eventTakeOver(keep: EventRow, duplicate: EventRow): string[] {
    const fields = takeOverMissing({ keep, duplicate }, EVENT_TAKE_OVER).fields.map((field) => EVENT_FIELD_LABELS[field] ?? field);
    if (this.links.missingLinks({ from: duplicate.id, to: keep.id }, EVENT_FIELD_TARGETS).length) fields.push('Verknüpfungen');
    return fields;
  }

  /** Keys of pairs rejected as different while both records exist; they stay remembered even when no longer detected. */
  private rememberedDifferent(prefix: string, exists: (id: string) => boolean): string[] {
    const keys: string[] = [];
    for (const insight of this.insights.list('rejected')) {
      if (insight.sourceIds.length !== 2) continue;
      const [a, b] = insight.sourceIds as [string, string];
      const key = duplicatePairKey(prefix, [a, b]);
      if (this.insights.byDedupeKey(key)?.id === insight.id && exists(a) && exists(b)) keys.push(key);
    }
    return keys;
  }

  /** Why a proposed merge can no longer be executed (record gone or already discarded), or null. */
  staleReason(kind: 'note' | 'event', keepId: string, duplicateId: string): string | null {
    return this.merger.staleReason(kind, { keepId, duplicateId });
  }

  mergeNotes(keepId: string, duplicateId: string, origin: Origin = {}): RecordMergeResult {
    return this.merger.mergeNotes({ keepId, duplicateId }, origin);
  }

  mergeEvents(keepId: string, duplicateId: string, origin: Origin = {}): RecordMergeResult {
    return this.merger.mergeEvents({ keepId, duplicateId }, origin);
  }
}
