import type { EntityRef, EntityType, RelationType } from '@archivist/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, events, relations } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { levenshtein, normalizeName, tokenize, truncate } from '../../util/text';
import type { AuditService } from '../audit';
import type { EventService } from '../events';
import type { InsightActionSpec, InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NoteService } from '../notes';
import type { UndoService } from '../undo';
import { chooseKept, duplicatePairKey, numbersDiffer, takeOverMissing, titleSimilarity, type TakeOverRules } from './record-merge';

type EventRow = typeof events.$inferSelect;
type EntityRow = typeof entities.$inferSelect;
type RelationRow = typeof relations.$inferSelect;

/** Audit undo types of {@link NoteEventDuplicateService.mergeNotes} and {@link NoteEventDuplicateService.mergeEvents}. */
export const NOTE_MERGE_UNDO_TYPE = 'note.merge_duplicate';
export const EVENT_MERGE_UNDO_TYPE = 'event.merge_duplicate';
/** Insight dedupe key prefixes; the key is the prefix plus the sorted ids of both records. */
export const NOTE_DUPLICATE_KEY_PREFIX = 'note-dup:';
export const EVENT_DUPLICATE_KEY_PREFIX = 'event-dup:';

// ---------------------------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------------------------

export interface NotePairAssessment {
  duplicate: boolean;
  /** `identical`: same text; `similar`: same words (order, punctuation, typos); `contained`: one note adds only a little. */
  match: 'identical' | 'similar' | 'contained' | null;
  /** Share of words both notes have in common (0..1). */
  similarity: number;
}

/** A longer note may add at most this share of words to a shorter one to count as the same note. */
const CONTAINED_MIN_RATIO = 0.8;

const words = (text: string) => [...new Set(tokenize(text, { keepStopwords: true }))];
/** Typos tolerated per word: none in short words, one from five letters on, two (e.g. swapped letters) from eight on. */
const typos = (w: string) => (w.length >= 8 ? 2 : w.length >= 5 ? 1 : 0);
/** A word is found if it occurs as is or with a few typos. */
const found = (w: string, list: string[]) => list.includes(w) || (typos(w) > 0 && list.some((x) => levenshtein(w, x) <= Math.min(typos(w), typos(x))));
/** An added negation turns a note into its opposite. */
const NEGATIONS = new Set(['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'nie', 'niemals', 'ohne', 'not', 'no', 'never']);
const numbers = (text: string) => new Set(text.match(/\d+/g) ?? []);
const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

/**
 * Are two notes the same? Only when their text is identical, uses the same words (apart from order, punctuation and
 * single typos), or one note repeats the other and adds very little. Notes that merely start the same way and then
 * differ („… Teil eins über Getränke“ / „… Teil zwei über das Essen“) stay separate, as do notes with other numbers.
 * Stopwords count, so „nicht“ makes a difference.
 */
export function assessNotePair(a: string, b: string): NotePairAssessment {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return { duplicate: false, match: null, similarity: 0 };
  if (na === nb) return { duplicate: true, match: 'identical', similarity: 1 };
  const wa = words(a);
  const wb = words(b);
  const missingInB = wa.filter((w) => !found(w, wb));
  const missingInA = wb.filter((w) => !found(w, wa));
  const similarity = (wa.length - missingInB.length + wb.length - missingInA.length) / (wa.length + wb.length || 1);
  const numsA = numbers(a);
  const numsB = numbers(b);
  if (!missingInA.length && !missingInB.length) {
    const same = subset(numsA, numsB) && subset(numsB, numsA);
    return { duplicate: same, match: same ? 'similar' : null, similarity };
  }
  if (missingInA.length && missingInB.length) return { duplicate: false, match: null, similarity };
  if ([...missingInA, ...missingInB].some((w) => NEGATIONS.has(w))) return { duplicate: false, match: null, similarity };
  // one note contains all words of the other: the same note only if the longer one adds very little
  const [short, long, shortNums, longNums] = missingInB.length ? [wb, wa, numsB, numsA] : [wa, wb, numsA, numsB];
  const contained = short.length >= 3 && short.length / long.length >= CONTAINED_MIN_RATIO && subset(shortNums, longNums);
  return { duplicate: contained, match: contained ? 'contained' : null, similarity };
}

export interface EventDraft {
  title: string;
  occurredAt: string;
  topicId?: string | null;
  projectId?: string | null;
}

export interface EventPairAssessment {
  duplicate: boolean;
  /** Title similarity (0..1). */
  similarity: number;
  /** German reasons for the insight text, e.g. „gleiches Thema“. */
  reasons: string[];
}

const EVENT_MIN_SIMILARITY = 0.7;

/**
 * Are two events the same? Same day and a similar title. Details set on both sides that differ (another time of
 * day, another topic or project, other numbers in the title) rule a duplicate out.
 */
export function assessEventPair(a: EventDraft, b: EventDraft): EventPairAssessment {
  const reasons: string[] = [];
  if (a.occurredAt.slice(0, 10) !== b.occurredAt.slice(0, 10)) return { duplicate: false, similarity: 0, reasons };
  const similarity = titleSimilarity({ title: a.title }, { title: b.title });
  let conflict = numbersDiffer(a.title, b.title);
  // both with a time of day: different times are different events
  if (a.occurredAt.length > 10 && b.occurredAt.length > 10 && a.occurredAt.slice(11, 16) !== b.occurredAt.slice(11, 16)) conflict = true;
  for (const [field, label] of [
    ['topicId', 'gleiches Thema'],
    ['projectId', 'gleiches Projekt'],
  ] as const) {
    const va = a[field];
    const vb = b[field];
    if (!va || !vb) continue;
    if (va === vb) reasons.push(label);
    else conflict = true;
  }
  return { duplicate: !conflict && similarity >= EVENT_MIN_SIMILARITY, similarity, reasons };
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/** What the kept event takes over from the duplicate. */
const EVENT_TAKE_OVER: TakeOverRules<EventRow> = {
  description: 'append',
  topicId: 'fill',
  projectId: 'fill',
  sourceIds: 'union',
};
const EVENT_FIELD_LABELS: Partial<Record<keyof EventRow, string>> = {
  description: 'Beschreibung',
  topicId: 'Thema',
  projectId: 'Projekt',
  sourceIds: 'Quellen',
};

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

export interface RecordMergeResult {
  auditId: string;
  keepId: string;
  duplicateId: string;
  keepTitle: string;
  duplicateTitle: string;
  /** German labels of what the kept record took over (fields, „Verknüpfungen“). */
  takenOver: string[];
}

interface CreatedRelation {
  id: string;
  updatedAt: string;
}

interface NoteMergeUndo {
  keepId: string;
  duplicateId: string;
  duplicateUpdatedAt: string;
  createdRelations: CreatedRelation[];
}

interface EventMergeUndo extends NoteMergeUndo {
  keepBefore: Partial<EventRow>;
  keepUpdatedAt: string;
}

const noteText = (n: Pick<EntityRow, 'name' | 'description'>) => n.description ?? n.name;
/** Cheap pre-filter: notes whose word counts differ more than this cannot be duplicates (see {@link assessNotePair}). */
const MIN_SIZE_RATIO = 0.7;
/** For events, topic and project are fields (taken over as such), not free links. */
const EVENT_FIELD_TARGETS: EntityType[] = ['topic', 'project'];

/**
 * Duplicate notes and events: the archive check proposes (as an insight with a `merge_notes`/`merge_events` action)
 * to keep one record, take over what it lacks from the other and mark the other as „verworfen (Duplikat)“ – nothing
 * is deleted, the merge is undoable, and rejecting the insight („Verschieden“) is remembered via its stable key.
 */
export class NoteEventDuplicateService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly notes: NoteService,
    private readonly eventRecords: EventService,
    private readonly audit: AuditService,
    undo: UndoService,
    private readonly insights: InsightService,
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
    return this.ctx.database.db;
  }

  private entity(id: string): EntityRow | undefined {
    return this.db.select().from(entities).where(eq(entities.id, id)).get();
  }

  private event(id: string): EventRow | undefined {
    return this.db.select().from(events).where(eq(events.id, id)).get();
  }

  // ---------- detection ----------

  /** Pairs of notes (not discarded) that look like duplicates; `keep` is the more complete one (on a tie the older one). */
  findNotePairs(): NoteDuplicatePair[] {
    const notes = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, 'note'), isNull(entities.duplicateOfId)))
      .all()
      .map((note) => ({ note, size: words(noteText(note)).length }))
      .sort((x, y) => x.size - y.size);
    const topics = new Map(notes.map(({ note }) => [note.id, this.contextLinks(note.id)]));
    const pairs: NoteDuplicatePair[] = [];
    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        // sorted by length: from here on the other notes have far more words, so none can be the same note
        if (notes[i]!.size < notes[j]!.size * MIN_SIZE_RATIO) break;
        const a = notes[i]!.note;
        const b = notes[j]!.note;
        const assessment = assessNotePair(noteText(a), noteText(b));
        if (!assessment.duplicate) continue;
        // both notes filed under topics/projects, but under different ones: not the same note
        const ta = topics.get(a.id)!;
        const tb = topics.get(b.id)!;
        if (ta.size && tb.size && ![...ta].some((t) => tb.has(t))) continue;
        pairs.push({ ...this.chooseKeptNote(a, b), assessment });
      }
    }
    return pairs;
  }

  /** Pairs of events (not discarded) on the same day with similar titles; `keep` is the event recorded first. */
  findEventPairs(): EventDuplicatePair[] {
    const byDay = new Map<string, EventRow[]>();
    for (const e of this.db.select().from(events).where(isNull(events.duplicateOfId)).all())
      byDay.set(e.occurredAt.slice(0, 10), [...(byDay.get(e.occurredAt.slice(0, 10)) ?? []), e]);
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
    const others = this.activeRelations(noteId).map((r) => (r.sourceEntityId === noteId ? r.targetEntityId : r.sourceEntityId));
    if (!others.length) return new Set();
    return new Set(
      this.db
        .select({ id: entities.id })
        .from(entities)
        .where(and(inArray(entities.id, others), inArray(entities.type, EVENT_FIELD_TARGETS)))
        .all()
        .map((e) => e.id),
    );
  }

  private chooseKeptNote(a: EntityRow, b: EntityRow): { keep: EntityRow; duplicate: EntityRow } {
    const la = words(noteText(a)).length;
    const lb = words(noteText(b)).length;
    if (la === lb) return chooseKept(a, b);
    return la > lb ? { keep: a, duplicate: b } : { keep: b, duplicate: a };
  }

  /**
   * Archive check step: one insight (with a merge proposal) per duplicate pair of notes and of events; hints whose
   * cause is gone are removed, while a „Verschieden“ (rejected hint) stays remembered as long as both records exist.
   */
  check(count?: (kind: string) => void): void {
    const noteKeys = new Set<string>();
    for (const { keep, duplicate, assessment } of this.findNotePairs()) {
      const key = duplicatePairKey(NOTE_DUPLICATE_KEY_PREFIX, keep.id, duplicate.id);
      noteKeys.add(key);
      const shown = this.insights.upsert(this.noteInsight(keep, duplicate, assessment, key));
      if (shown.status === 'open') count?.('duplicate_note');
    }
    const eventKeys = new Set<string>();
    for (const { keep, duplicate, assessment } of this.findEventPairs()) {
      const key = duplicatePairKey(EVENT_DUPLICATE_KEY_PREFIX, keep.id, duplicate.id);
      eventKeys.add(key);
      const shown = this.insights.upsert(this.eventInsight(keep, duplicate, assessment, key));
      if (shown.status === 'open') count?.('duplicate_event');
    }
    for (const key of this.rememberedDifferent(NOTE_DUPLICATE_KEY_PREFIX, (id) => this.entity(id)?.type === 'note')) noteKeys.add(key);
    for (const key of this.rememberedDifferent(EVENT_DUPLICATE_KEY_PREFIX, (id) => Boolean(this.event(id)))) eventKeys.add(key);
    this.insights.reconcile(NOTE_DUPLICATE_KEY_PREFIX, noteKeys);
    this.insights.reconcile(EVENT_DUPLICATE_KEY_PREFIX, eventKeys);
  }

  /**
   * Keys of pairs the user marked as different („Verschieden“ = rejected insight) while both records still exist: they
   * stay remembered even if the pair is currently not detected (one record edited, merged elsewhere, …).
   */
  private rememberedDifferent(prefix: string, exists: (id: string) => boolean): string[] {
    const keys: string[] = [];
    for (const i of this.insights.list('rejected')) {
      if (i.sourceIds.length !== 2) continue;
      const [a, b] = i.sourceIds as [string, string];
      const key = duplicatePairKey(prefix, a, b);
      if (this.insights.byDedupeKey(key)?.id === i.id && exists(a) && exists(b)) keys.push(key);
    }
    return keys;
  }

  private noteInsight(keep: EntityRow, dup: EntityRow, a: NotePairAssessment, key: string) {
    const how =
      a.match === 'identical'
        ? 'haben denselben Inhalt'
        : a.match === 'similar'
          ? 'enthalten dieselben Wörter (bis auf Reihenfolge, Satzzeichen oder Tippfehler)'
          : `sind nahezu gleich (${Math.round(a.similarity * 100)} % gemeinsame Wörter)`;
    const links = this.missingLinks(dup.id, keep.id, []).length;
    const affected: EntityRef[] = [
      { type: 'note', id: keep.id, label: keep.name },
      { type: 'note', id: dup.id, label: dup.name },
    ];
    const confidence = a.match === 'identical' ? 0.95 : 0.8;
    const action: InsightActionSpec = {
      label: 'Zusammenführen',
      proposal: {
        actionType: 'merge_notes',
        label: `Notiz „${truncate(dup.name, 60)}“ als Duplikat verwerfen`,
        rationale: `Die beiden Notizen ${how}.`,
        confidence,
        affectedEntities: affected,
        requiredConfirmation: 'confirm',
        proposedParameters: { keepId: keep.id, duplicateId: dup.id },
      },
    };
    return {
      kind: 'duplicate' as const,
      title: `Doppelte Notiz: „${truncate(keep.name, 70)}“`,
      explanation: [
        `Zwei Notizen ${how}:\n• ${truncate(noteText(keep), 200)}\n• ${truncate(noteText(dup), 200)}`,
        `Vorschlag: die ${words(noteText(keep)).length > words(noteText(dup)).length ? 'ausführlichere' : 'zuerst erfasste'} Notiz „${truncate(keep.name, 70)}“ behalten${links ? `, ${links} fehlende Verknüpfung(en) übernehmen` : ''} und die andere als „verworfen (Duplikat)“ markieren.`,
        'Es wird nichts gelöscht, und die Zusammenführung lässt sich rückgängig machen. Sind es verschiedene Notizen, lehne den Hinweis ab – er erscheint dann nicht wieder.',
      ].join('\n\n'),
      confidence,
      affected,
      sourceIds: [keep.id, dup.id],
      action,
      dedupeKey: key,
    };
  }

  private eventInsight(keep: EventRow, dup: EventRow, a: EventPairAssessment, key: string) {
    const fields = takeOverMissing(keep, dup, EVENT_TAKE_OVER).fields.map((f) => EVENT_FIELD_LABELS[f] ?? f);
    if (this.missingLinks(dup.id, keep.id, EVENT_FIELD_TARGETS).length) fields.push('Verknüpfungen');
    const day = keep.occurredAt.slice(0, 10);
    const why = `Gleiches Datum (${day}), ähnlicher Titel (${Math.round(a.similarity * 100)} %)${a.reasons.length ? `, ${a.reasons.join(', ')}` : ''}.`;
    const affected: EntityRef[] = [
      { type: 'event', id: keep.id, label: keep.title },
      { type: 'event', id: dup.id, label: dup.title },
    ];
    const confidence = Math.min(0.95, 0.5 + a.similarity * 0.4 + a.reasons.length * 0.05);
    const action: InsightActionSpec = {
      label: 'Zusammenführen',
      proposal: {
        actionType: 'merge_events',
        label: `„${truncate(dup.title, 60)}“ als Duplikat von „${truncate(keep.title, 60)}“ verwerfen`,
        rationale: why,
        confidence,
        affectedEntities: affected,
        requiredConfirmation: 'confirm',
        proposedParameters: { keepId: keep.id, duplicateId: dup.id },
      },
    };
    return {
      kind: 'duplicate' as const,
      title: `Doppeltes Ereignis: „${truncate(keep.title, 70)}“ (${day})`,
      explanation: [
        `„${keep.title}“ und „${dup.title}“ beschreiben vermutlich dasselbe Ereignis. ${why}`,
        `Vorschlag: „${keep.title}“ (zuerst erfasst) behalten${fields.length ? `, fehlende Angaben übernehmen (${fields.join(', ')})` : ''} und „${dup.title}“ als „verworfen (Duplikat)“ markieren.`,
        'Es wird nichts gelöscht, und die Zusammenführung lässt sich rückgängig machen. Sind es verschiedene Ereignisse, lehne den Hinweis ab – er erscheint dann nicht wieder.',
      ].join('\n\n'),
      confidence,
      affected,
      sourceIds: [keep.id, dup.id],
      action,
      dedupeKey: key,
    };
  }

  // ---------- links ----------

  private activeRelations(entityId: string): RelationRow[] {
    return this.db
      .select()
      .from(relations)
      .where(and(or(eq(relations.sourceEntityId, entityId), eq(relations.targetEntityId, entityId)), inArray(relations.status, ['proposed', 'confirmed'])))
      .all();
  }

  /** Active links of `fromId` that `toId` does not have yet (same direction and type), except to `skipTypes`. */
  private missingLinks(fromId: string, toId: string, skipTypes: EntityType[]): Array<{ source: string; target: string; type: RelationType; row: RelationRow }> {
    const out: Array<{ source: string; target: string; type: RelationType; row: RelationRow }> = [];
    for (const r of this.activeRelations(fromId)) {
      const outgoing = r.sourceEntityId === fromId;
      const other = outgoing ? r.targetEntityId : r.sourceEntityId;
      if (other === toId) continue;
      if (skipTypes.length) {
        const type = this.entity(other)?.type as EntityType | undefined;
        if (type && skipTypes.includes(type)) continue;
      }
      const source = outgoing ? toId : other;
      const target = outgoing ? other : toId;
      const exists = this.db
        .select({ id: relations.id })
        .from(relations)
        .where(and(eq(relations.sourceEntityId, source), eq(relations.targetEntityId, target), eq(relations.relationType, r.relationType)))
        .get();
      if (!exists) out.push({ source, target, type: r.relationType as RelationType, row: r });
    }
    return out;
  }

  /** Creates a link that does not exist yet and returns it for the undo (existing links are never touched). */
  private linkNew(source: string, target: string, type: RelationType, opts: { confidence: number; status: 'proposed' | 'confirmed'; sourceIds: string[] }) {
    const exists = this.db
      .select({ id: relations.id })
      .from(relations)
      .where(and(eq(relations.sourceEntityId, source), eq(relations.targetEntityId, target), eq(relations.relationType, type)))
      .get();
    if (exists) return null;
    const rel = this.graph.link(source, target, type, opts);
    return rel ? { id: rel.id, updatedAt: rel.updatedAt } : null;
  }

  private copyLinks(fromId: string, toId: string, skipTypes: EntityType[]): CreatedRelation[] {
    const created: CreatedRelation[] = [];
    for (const l of this.missingLinks(fromId, toId, skipTypes)) {
      const rel = this.linkNew(l.source, l.target, l.type, {
        confidence: l.row.confidence,
        status: l.row.status === 'confirmed' ? 'confirmed' : 'proposed',
        sourceIds: l.row.sourceIds,
      });
      if (rel) created.push(rel);
    }
    return created;
  }

  /** The discarded record points to the kept one in the knowledge graph (`duplicate_of`); removed again on undo. */
  private markLink(duplicateId: string, keepId: string): CreatedRelation[] {
    const rel = this.linkNew(duplicateId, keepId, 'duplicate_of', { confidence: 1, status: 'confirmed', sourceIds: [] });
    return rel ? [rel] : [];
  }

  /** Why a proposed merge can no longer be executed (record gone or already discarded), or null. */
  staleReason(kind: 'note' | 'event', keepId: string, duplicateId: string): string | null {
    const label = kind === 'note' ? 'Notiz' : 'Ereignis';
    const keep = kind === 'note' ? this.entity(keepId) : this.event(keepId);
    const dup = kind === 'note' ? this.entity(duplicateId) : this.event(duplicateId);
    if (!keep || !dup) return `Eines der beiden Elemente (${label}) existiert nicht mehr.`;
    if (dup.duplicateOfId) return `Das Element „${'title' in dup ? dup.title : dup.name}“ ist bereits als Duplikat verworfen.`;
    if (keep.duplicateOfId) return `Das Element „${'title' in keep ? keep.title : keep.name}“ ist inzwischen selbst als Duplikat verworfen.`;
    return null;
  }

  // ---------- merge notes ----------

  /**
   * Keeps note `keepId`, takes over the links it lacks from `duplicateId` and marks the duplicate as discarded
   * (`duplicateOfId`, no longer searchable). One audit entry, undoable while nothing changed.
   */
  mergeNotes(keepId: string, duplicateId: string, opts: { actor?: 'user' | 'agent'; trigger?: string } = {}): RecordMergeResult {
    if (keepId === duplicateId) throw new AppError('validation_error', 'Eine Notiz kann nicht mit sich selbst zusammengeführt werden.');
    const keep = this.entity(keepId);
    const dup = this.entity(duplicateId);
    if (keep?.type !== 'note' || dup?.type !== 'note') throw new AppError('validation_error', 'Notiz nicht gefunden.');
    const stale = this.staleReason('note', keepId, duplicateId);
    if (stale) throw new AppError('validation_error', stale);
    const now = nowIso();
    const res = this.ctx.database.transaction(() => {
      const copied = this.copyLinks(dup.id, keep.id, []);
      const createdRelations = [...copied, ...this.markLink(dup.id, keep.id)];
      this.db.update(entities).set({ duplicateOfId: keep.id, updatedAt: now }).where(eq(entities.id, dup.id)).run();
      const data: NoteMergeUndo = { keepId: keep.id, duplicateId: dup.id, duplicateUpdatedAt: now, createdRelations };
      return {
        id: this.audit.log({
          action: 'note.merge_duplicate',
          actor: opts.actor ?? 'user',
          trigger: opts.trigger ?? 'manual',
          confirmed: true,
          entityIds: [keep.id, dup.id],
          before: { duplicate: { duplicateOfId: null } },
          after: { duplicate: { duplicateOfId: keep.id }, relations: createdRelations.map((r) => r.id) },
          undo: { type: NOTE_MERGE_UNDO_TYPE, data },
        }),
        links: copied.length,
      };
    });
    void this.notes.reindex(dup.id);
    this.ctx.events.changed('knowledge', 'status');
    return {
      auditId: res.id,
      keepId: keep.id,
      duplicateId: dup.id,
      keepTitle: keep.name,
      duplicateTitle: dup.name,
      takenOver: res.links ? [`${res.links} Verknüpfung(en)`] : [],
    };
  }

  private createdRelationConflicts(created: CreatedRelation[]): string[] {
    if (!created.length) return [];
    const now = this.db
      .select({ id: relations.id, updatedAt: relations.updatedAt })
      .from(relations)
      .where(
        inArray(
          relations.id,
          created.map((r) => r.id),
        ),
      )
      .all();
    const changed = now.some((r) => created.find((c) => c.id === r.id)?.updatedAt !== r.updatedAt);
    return changed ? ['Eine bei der Zusammenführung übernommene Verknüpfung wurde seitdem geändert.'] : [];
  }

  private noteUndoConflicts(d: NoteMergeUndo): string[] {
    const keep = this.entity(d.keepId);
    const dup = this.entity(d.duplicateId);
    if (!keep || !dup) return ['Eine der zusammengeführten Notizen existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (dup.updatedAt !== d.duplicateUpdatedAt || dup.duplicateOfId !== d.keepId)
      conflicts.push(`Die als Duplikat verworfene Notiz „${dup.name}“ wurde seit der Zusammenführung verändert.`);
    return [...conflicts, ...this.createdRelationConflicts(d.createdRelations)];
  }

  private undoNoteMerge(d: NoteMergeUndo): string {
    this.ctx.database.transaction(() => {
      this.db.update(entities).set({ duplicateOfId: null, updatedAt: nowIso() }).where(eq(entities.id, d.duplicateId)).run();
      if (d.createdRelations.length)
        this.db
          .delete(relations)
          .where(
            inArray(
              relations.id,
              d.createdRelations.map((r) => r.id),
            ),
          )
          .run();
    });
    void this.notes.reindex(d.duplicateId);
    this.ctx.events.changed('knowledge', 'status');
    return 'Zusammenführung der Notizen rückgängig gemacht.';
  }

  // ---------- merge events ----------

  /**
   * Keeps event `keepId`, takes over the details it lacks from `duplicateId` (description appended, topic and project
   * filled, sources united, other links copied) and marks the duplicate as discarded (`duplicateOfId`, hidden from the
   * timeline and the search). One audit entry, undoable while neither event changed.
   */
  mergeEvents(keepId: string, duplicateId: string, opts: { actor?: 'user' | 'agent'; trigger?: string } = {}): RecordMergeResult {
    if (keepId === duplicateId) throw new AppError('validation_error', 'Ein Ereignis kann nicht mit sich selbst zusammengeführt werden.');
    const keep = this.event(keepId);
    const dup = this.event(duplicateId);
    if (!keep || !dup) throw new AppError('validation_error', 'Ereignis nicht gefunden.');
    const stale = this.staleReason('event', keepId, duplicateId);
    if (stale) throw new AppError('validation_error', stale);
    const { patch, before, fields } = takeOverMissing(keep, dup, EVENT_TAKE_OVER);
    const now = nowIso();
    const res = this.ctx.database.transaction(() => {
      this.db
        .update(events)
        .set({ ...patch, updatedAt: now })
        .where(eq(events.id, keep.id))
        .run();
      if (patch.description !== undefined) this.graph.registerNode('event', keep.id, keep.title, patch.description);
      const createdRelations: CreatedRelation[] = [];
      const add = (r: CreatedRelation | null) => r && createdRelations.push(r);
      const sourceIds = patch.sourceIds ?? keep.sourceIds;
      if (patch.topicId) add(this.linkNew(keep.id, patch.topicId, 'relates_to', { confidence: 0.9, status: 'confirmed', sourceIds }));
      if (patch.projectId) add(this.linkNew(keep.id, patch.projectId, 'belongs_to', { confidence: 0.9, status: 'confirmed', sourceIds }));
      const copied = this.copyLinks(dup.id, keep.id, EVENT_FIELD_TARGETS);
      createdRelations.push(...copied, ...this.markLink(dup.id, keep.id));
      this.db.update(events).set({ duplicateOfId: keep.id, updatedAt: now }).where(eq(events.id, dup.id)).run();
      this.db.update(entities).set({ duplicateOfId: keep.id, updatedAt: now }).where(eq(entities.id, dup.id)).run();
      const data: EventMergeUndo = {
        keepId: keep.id,
        duplicateId: dup.id,
        keepBefore: before,
        keepUpdatedAt: now,
        duplicateUpdatedAt: now,
        createdRelations,
      };
      return {
        id: this.audit.log({
          action: 'event.merge_duplicate',
          actor: opts.actor ?? 'user',
          trigger: opts.trigger ?? 'manual',
          confirmed: true,
          entityIds: [keep.id, dup.id],
          before: { keep: before, duplicate: { duplicateOfId: null } },
          after: { keep: patch, duplicate: { duplicateOfId: keep.id }, relations: createdRelations.map((r) => r.id) },
          undo: { type: EVENT_MERGE_UNDO_TYPE, data },
        }),
        links: copied.length,
      };
    });
    void this.eventRecords.reindex(keep.id);
    void this.eventRecords.reindex(dup.id);
    this.ctx.events.changed('events', 'knowledge', 'status');
    const takenOver = fields.map((f) => EVENT_FIELD_LABELS[f] ?? f);
    if (res.links > 0) takenOver.push('Verknüpfungen');
    return { auditId: res.id, keepId: keep.id, duplicateId: dup.id, keepTitle: keep.title, duplicateTitle: dup.title, takenOver };
  }

  private eventUndoConflicts(d: EventMergeUndo): string[] {
    const keep = this.event(d.keepId);
    const dup = this.event(d.duplicateId);
    if (!keep || !dup) return ['Eines der zusammengeführten Ereignisse existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (keep.updatedAt !== d.keepUpdatedAt) conflicts.push(`Das behaltene Ereignis „${keep.title}“ wurde seit der Zusammenführung verändert.`);
    if (dup.updatedAt !== d.duplicateUpdatedAt || dup.duplicateOfId !== d.keepId)
      conflicts.push(`Das als Duplikat verworfene Ereignis „${dup.title}“ wurde seit der Zusammenführung verändert.`);
    return [...conflicts, ...this.createdRelationConflicts(d.createdRelations)];
  }

  private undoEventMerge(d: EventMergeUndo): string {
    const now = nowIso();
    this.ctx.database.transaction(() => {
      this.db
        .update(events)
        .set({ ...d.keepBefore, updatedAt: now })
        .where(eq(events.id, d.keepId))
        .run();
      this.db.update(events).set({ duplicateOfId: null, updatedAt: now }).where(eq(events.id, d.duplicateId)).run();
      this.db.update(entities).set({ duplicateOfId: null, updatedAt: now }).where(eq(entities.id, d.duplicateId)).run();
      if ('description' in d.keepBefore) {
        const keep = this.event(d.keepId)!;
        this.graph.registerNode('event', keep.id, keep.title, keep.description);
      }
      if (d.createdRelations.length)
        this.db
          .delete(relations)
          .where(
            inArray(
              relations.id,
              d.createdRelations.map((r) => r.id),
            ),
          )
          .run();
    });
    void this.eventRecords.reindex(d.keepId);
    void this.eventRecords.reindex(d.duplicateId);
    this.ctx.events.changed('events', 'knowledge', 'status');
    return 'Zusammenführung der Ereignisse rückgängig gemacht.';
  }
}
