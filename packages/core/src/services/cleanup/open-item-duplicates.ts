import type { EntityRef, OpenItem } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { openItems, relations, reminders } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { normalizeName, tokenize, truncate } from '../../util/text';
import type { AuditService } from '../audit';
import type { InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import { ACTIVE_STATUSES, hintTokens, scoreHintTokens, type OpenItemService } from '../open-items';
import { syncReminderAt } from '../reminders';
import type { UndoService } from '../undo';
import { chooseKept, duplicatePairKey, numbersDiffer, takeOverMissing, titleSimilarity, type TakeOverRules } from './record-merge';

type Row = typeof openItems.$inferSelect;

/** Audit undo type of {@link OpenItemDuplicateService.merge}. */
export const OPEN_ITEM_MERGE_UNDO_TYPE = 'open_item.merge_duplicate';
/** Insight dedupe key prefix; the key is the prefix plus the sorted ids of both items. */
export const OPEN_ITEM_DUPLICATE_KEY_PREFIX = 'open-item-dup:';

/** What the kept item takes over from the duplicate (reminders are moved separately). */
const TAKE_OVER: TakeOverRules<Row> = {
  description: 'append',
  dueAt: 'fill',
  responsiblePersonId: 'fill',
  topicId: 'fill',
  projectId: 'fill',
  sourceIds: 'union',
};
const FIELD_LABELS: Partial<Record<keyof Row, string>> = {
  description: 'Beschreibung',
  dueAt: 'Fälligkeit',
  responsiblePersonId: 'Verantwortlicher',
  topicId: 'Thema',
  projectId: 'Projekt',
  sourceIds: 'Quellen',
};

/** Minimal shape compared by the detector (stored items and drafts typed in the chat). */
export interface OpenItemDraft {
  title: string;
  description?: string | null;
  topicId?: string | null;
  projectId?: string | null;
  responsiblePersonId?: string | null;
}

export interface DuplicateAssessment {
  duplicate: boolean;
  /** Title/description similarity plus agreeing details (0..~1.3). */
  score: number;
  /** Title/description similarity alone (0..1). */
  similarity: number;
  /** Details set on both sides differ (person, topic, project, numbers in the title): not the same item. */
  conflict: boolean;
  /** German reasons for the insight text, e.g. „gleicher Verantwortlicher“. */
  reasons: string[];
}

const MIN_SIMILARITY = 0.6;
const DUPLICATE_SCORE = 0.8;
const CONTEXT_FIELDS = [
  ['topicId', 'gleiches Thema'],
  ['projectId', 'gleiches Projekt'],
  ['responsiblePersonId', 'gleicher Verantwortlicher'],
] as const;

/**
 * Are two open items the same? Criteria: title and description (open-item matcher, both directions), topic, project
 * and responsible person. Details set on both sides that differ (another person, another project, other numbers in
 * the title) rule a duplicate out; agreeing details raise the score.
 */
export function assessOpenItemPair(a: OpenItemDraft, b: OpenItemDraft): DuplicateAssessment {
  const similarity = titleSimilarity(a, b);
  const reasons: string[] = [];
  let score = similarity;
  let conflict = numbersDiffer(a.title, b.title);
  for (const [field, label] of CONTEXT_FIELDS) {
    const va = a[field];
    const vb = b[field];
    if (!va || !vb) continue;
    if (va === vb) {
      score += 0.1;
      reasons.push(label);
    } else conflict = true;
  }
  if (a.description?.trim() && b.description?.trim() && normalizeName(a.description) === normalizeName(b.description)) {
    score += 0.1;
    reasons.push('gleiche Beschreibung');
  }
  return { duplicate: !conflict && similarity >= MIN_SIMILARITY && score >= DUPLICATE_SCORE, score, similarity, conflict, reasons };
}

/** A short draft title that is fully contained in an existing item („Angebot Müller“ in „Angebot für Müller prüfen …“). */
const DRAFT_CONTAINED = 0.75;

/**
 * Best existing duplicate of a draft (before the chat creates a new open item), or null. Besides real duplicates
 * (see {@link assessOpenItemPair}) a draft whose title is found in an existing item counts, unless details conflict –
 * the chat only asks („ergänzen oder neu anlegen?“), so it may be more generous than the archive check.
 */
export function findOpenItemDuplicate<T extends OpenItemDraft>(draft: OpenItemDraft, items: T[]): T | null {
  const wanted = hintTokens(draft.title);
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const a = assessOpenItemPair(draft, item);
    const contained = !a.conflict && scoreHintTokens(wanted, item) >= DRAFT_CONTAINED;
    const score = Math.max(a.duplicate ? a.score : 0, contained ? a.score + 0.1 : 0);
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

/** Cheap pre-filter: two titles can only match if they share a word stem (first three letters). */
const stems = (title: string) => new Set(tokenize(title).map((t) => t.slice(0, 3)));

export interface DuplicatePair {
  keep: OpenItem;
  duplicate: OpenItem;
  assessment: DuplicateAssessment;
}

export interface OpenItemMergeResult {
  auditId: string;
  keep: OpenItem;
  duplicate: OpenItem;
  /** German labels of the details taken over (plus „Erinnerungen“ when reminders were moved). */
  takenOver: string[];
}

interface MergeUndoData {
  keepId: string;
  duplicateId: string;
  keepBefore: Partial<Row>;
  duplicateBefore: { status: string; duplicateOfId: string | null };
  movedReminderIds: string[];
  createdRelationIds: string[];
  keepUpdatedAt: string;
  duplicateUpdatedAt: string;
}

/**
 * Duplicate open items: the archive check proposes (as an insight with a `merge_open_items` action) to keep the item
 * recorded first, take over the details it lacks and discard the other one as „verworfen (Duplikat)“. Nothing is
 * deleted, the merge is undoable, and rejecting the insight („Verschieden“) is remembered via its stable key.
 */
export class OpenItemDuplicateService {
  constructor(
    private readonly ctx: AppContext,
    private readonly openItems: OpenItemService,
    private readonly graph: KnowledgeGraphService,
    private readonly audit: AuditService,
    undo: UndoService,
    private readonly insights: InsightService,
  ) {
    undo.register(OPEN_ITEM_MERGE_UNDO_TYPE, {
      check: async (data) => this.undoConflicts(data as MergeUndoData),
      run: async (data) => this.undoMerge(data as MergeUndoData),
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  private row(id: string): Row | undefined {
    return this.db.select().from(openItems).where(eq(openItems.id, id)).get();
  }

  /** All pairs of active open items that look like duplicates; `keep` is the item recorded first. */
  findPairs(items: OpenItem[] = this.openItems.list({ onlyActive: true })): DuplicatePair[] {
    const withStems = items.map((item) => ({ item, stems: stems(item.title) }));
    const pairs: DuplicatePair[] = [];
    for (let i = 0; i < withStems.length; i += 1) {
      for (let j = i + 1; j < withStems.length; j += 1) {
        const a = withStems[i]!;
        const b = withStems[j]!;
        if (![...a.stems].some((s) => b.stems.has(s))) continue;
        const assessment = assessOpenItemPair(a.item, b.item);
        if (assessment.duplicate) pairs.push({ ...chooseKept(a.item, b.item), assessment });
      }
    }
    return pairs;
  }

  /** Archive check step: one insight (with a merge proposal) per duplicate pair; insights whose cause is gone are reconciled away. */
  check(count?: (kind: string) => void): number {
    const keepKeys = new Set<string>();
    let found = 0;
    for (const { keep, duplicate, assessment } of this.findPairs()) {
      const key = duplicatePairKey(OPEN_ITEM_DUPLICATE_KEY_PREFIX, keep.id, duplicate.id);
      keepKeys.add(key);
      // a rejected hint („Verschieden“) stays rejected: upsert neither reopens it nor proposes its action again
      const keepRow = this.row(keep.id)!;
      const dupRow = this.row(duplicate.id)!;
      const fields = takeOverMissing(keepRow, dupRow, TAKE_OVER).fields.map((f) => FIELD_LABELS[f] ?? f);
      if (this.pendingReminders(duplicate.id).length) fields.push('Erinnerungen');
      const affected: EntityRef[] = [
        { type: 'task', id: keep.id, label: keep.title },
        { type: 'task', id: duplicate.id, label: duplicate.title },
      ];
      this.insights.upsert({
        kind: 'duplicate',
        title: `Doppelter offener Punkt: „${truncate(keep.title, 70)}“`,
        explanation: [
          `„${keep.title}“ und „${duplicate.title}“ beschreiben vermutlich dieselbe Aufgabe (Titel/Beschreibung ${Math.round(assessment.similarity * 100)} %${assessment.reasons.length ? `, ${assessment.reasons.join(', ')}` : ''}).`,
          `Vorschlag: „${keep.title}“ (zuerst erfasst) behalten${fields.length ? `, fehlende Angaben übernehmen (${fields.join(', ')})` : ''} und „${duplicate.title}“ als „verworfen (Duplikat)“ markieren.`,
          'Es wird nichts gelöscht, und die Zusammenführung lässt sich rückgängig machen. Sind es verschiedene Punkte, lehne den Hinweis ab – er erscheint dann nicht wieder.',
        ].join('\n\n'),
        confidence: Math.min(0.95, assessment.score),
        affected,
        sourceIds: [keep.id, duplicate.id],
        action: {
          proposal: {
            actionType: 'merge_open_items',
            label: `„${truncate(duplicate.title, 60)}“ als Duplikat von „${truncate(keep.title, 60)}“ verwerfen`,
            rationale: `Die offenen Punkte ähneln sich (Titel/Beschreibung ${Math.round(assessment.similarity * 100)} %${assessment.reasons.length ? `, ${assessment.reasons.join(', ')}` : ''}).`,
            confidence: Math.min(0.95, assessment.score),
            affectedEntities: affected,
            requiredConfirmation: 'confirm',
            proposedParameters: { keepId: keep.id, duplicateId: duplicate.id },
          },
          label: 'Zusammenführen',
        },
        dedupeKey: key,
      });
      count?.('duplicate_open_item');
      found += 1;
    }
    // hints whose cause is gone are removed (their proposals withdrawn); „Verschieden“ is kept while both items exist
    for (const key of this.rememberedDifferent()) keepKeys.add(key);
    this.insights.reconcile(OPEN_ITEM_DUPLICATE_KEY_PREFIX, keepKeys);
    return found;
  }

  /**
   * Keys of pairs the user marked as different („Verschieden“ = rejected insight) while both items still exist: they
   * stay remembered even if the pair is currently not detected (one item closed, renamed, …), so it is never asked again.
   */
  private rememberedDifferent(): string[] {
    const keys: string[] = [];
    for (const i of this.insights.list('rejected')) {
      if (i.kind !== 'duplicate' || i.sourceIds.length !== 2) continue;
      const [a, b] = i.sourceIds as [string, string];
      if (this.row(a) && this.row(b)) keys.push(duplicatePairKey(OPEN_ITEM_DUPLICATE_KEY_PREFIX, a, b));
    }
    return keys;
  }

  private pendingReminders(openItemId: string) {
    return this.db
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, openItemId), inArray(reminders.status, ['pending', 'fired'])))
      .all();
  }

  /** Links `from → to` in the graph and returns the relation id when it did not exist before (undo removes it again). */
  private linkNew(from: string, to: string, type: 'relates_to' | 'belongs_to' | 'results_from', confidence: number, sourceIds: string[] = []): string | null {
    const exists = this.db
      .select({ id: relations.id })
      .from(relations)
      .where(and(eq(relations.sourceEntityId, from), eq(relations.targetEntityId, to), eq(relations.relationType, type)))
      .get();
    const rel = this.graph.link(from, to, type, { confidence, status: 'confirmed', sourceIds });
    return !exists && rel ? rel.id : null;
  }

  /** Why `keepId` and `duplicateId` can no longer be merged (null: they can) – also re-checked before a proposal runs. */
  staleReason(keepId: string, duplicateId: string): string | null {
    if (keepId === duplicateId) return 'Ein offener Punkt kann nicht mit sich selbst zusammengeführt werden.';
    const keep = this.row(keepId);
    const dup = this.row(duplicateId);
    if (!keep || !dup) return 'Offener Punkt nicht gefunden.';
    if (!ACTIVE_STATUSES.includes(keep.status as OpenItem['status']) || !ACTIVE_STATUSES.includes(dup.status as OpenItem['status']))
      return 'Nur aktive offene Punkte können zusammengeführt werden.';
    return null;
  }

  /**
   * Keeps `keepId`, takes over the details it lacks from `duplicateId` (description is appended, due date, responsible
   * person, topic and project are filled, sources united, pending reminders moved) and marks the duplicate as
   * `dismissed` with `duplicateOfId`. One audit entry, undoable while neither item changed.
   */
  merge(keepId: string, duplicateId: string, opts: { actor?: 'user' | 'agent'; trigger?: string } = {}): OpenItemMergeResult {
    const stale = this.staleReason(keepId, duplicateId);
    if (stale) throw new AppError('validation_error', stale);
    const keep = this.row(keepId)!;
    const dup = this.row(duplicateId)!;
    const { patch, before, fields } = takeOverMissing(keep, dup, TAKE_OVER);
    const set: Partial<Row> = { ...patch };
    const keepBefore: Partial<Row> = { ...before };
    if (patch.dueAt && keep.dueUnknown) {
      set.dueUnknown = false;
      keepBefore.dueUnknown = true;
    }
    if (patch.responsiblePersonId && keep.responsibleUnknown) {
      set.responsibleUnknown = false;
      keepBefore.responsibleUnknown = true;
    }
    const moved = this.pendingReminders(dup.id).map((r) => r.id);
    const now = nowIso();
    const createdRelationIds: string[] = [];
    const auditId = this.ctx.database.transaction(() => {
      this.db
        .update(openItems)
        .set({ ...set, updatedAt: now })
        .where(eq(openItems.id, keep.id))
        .run();
      this.db.update(openItems).set({ status: 'dismissed', duplicateOfId: keep.id, updatedAt: now }).where(eq(openItems.id, dup.id)).run();
      if (moved.length) this.db.update(reminders).set({ targetId: keep.id }).where(inArray(reminders.id, moved)).run();
      syncReminderAt(this.db, keep.id);
      syncReminderAt(this.db, dup.id);
      if (patch.description !== undefined) this.graph.registerNode('task', keep.id, keep.title, patch.description);
      const add = (id: string | null) => id && createdRelationIds.push(id);
      if (patch.topicId) add(this.linkNew(keep.id, patch.topicId, 'relates_to', keep.confidence, patch.sourceIds ?? keep.sourceIds));
      if (patch.projectId) add(this.linkNew(keep.id, patch.projectId, 'belongs_to', keep.confidence, patch.sourceIds ?? keep.sourceIds));
      for (const src of (patch.sourceIds ?? []).filter((s) => !keep.sourceIds.includes(s))) {
        const type = this.graph.getEntity(src)?.type;
        if (type === 'decision' || type === 'document') add(this.linkNew(keep.id, src, 'results_from', keep.confidence, [src]));
      }
      const data: MergeUndoData = {
        keepId: keep.id,
        duplicateId: dup.id,
        keepBefore,
        duplicateBefore: { status: dup.status, duplicateOfId: dup.duplicateOfId },
        movedReminderIds: moved,
        createdRelationIds,
        keepUpdatedAt: now,
        duplicateUpdatedAt: now,
      };
      return this.audit.log({
        action: 'open_item.merge_duplicate',
        actor: opts.actor ?? 'user',
        trigger: opts.trigger ?? 'manual',
        confirmed: true,
        entityIds: [keep.id, dup.id],
        before: { keep: keepBefore, duplicate: data.duplicateBefore },
        after: { keep: set, duplicate: { status: 'dismissed', duplicateOfId: keep.id }, reminders: moved },
        undo: { type: OPEN_ITEM_MERGE_UNDO_TYPE, data },
      });
    });
    void this.openItems.reindex(keep.id);
    void this.openItems.reindex(dup.id);
    this.ctx.events.changed('openItems', 'reminders', 'knowledge', 'status');
    const takenOver = fields.map((f) => FIELD_LABELS[f] ?? f);
    if (moved.length) takenOver.push('Erinnerungen');
    return { auditId, keep: this.openItems.get(keep.id), duplicate: this.openItems.get(dup.id), takenOver };
  }

  private undoConflicts(d: MergeUndoData): string[] {
    const keep = this.row(d.keepId);
    const dup = this.row(d.duplicateId);
    if (!keep || !dup) return ['Einer der zusammengeführten offenen Punkte existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (keep.updatedAt !== d.keepUpdatedAt) conflicts.push(`Der behaltene Punkt „${keep.title}“ wurde seit der Zusammenführung verändert.`);
    if (dup.updatedAt !== d.duplicateUpdatedAt) conflicts.push(`Der als Duplikat verworfene Punkt „${dup.title}“ wurde seit der Zusammenführung verändert.`);
    if (d.movedReminderIds.length) {
      const still = this.db.select({ id: reminders.id, targetId: reminders.targetId }).from(reminders).where(inArray(reminders.id, d.movedReminderIds)).all();
      if (still.length !== d.movedReminderIds.length || still.some((r) => r.targetId !== d.keepId))
        conflicts.push('Eine übernommene Erinnerung wurde seitdem gelöscht oder einem anderen Punkt zugeordnet.');
    }
    return conflicts;
  }

  private undoMerge(d: MergeUndoData): string {
    const now = nowIso();
    const keep = this.row(d.keepId)!;
    this.ctx.database.transaction(() => {
      this.db
        .update(openItems)
        .set({ ...d.keepBefore, updatedAt: now })
        .where(eq(openItems.id, d.keepId))
        .run();
      this.db
        .update(openItems)
        .set({ status: d.duplicateBefore.status, duplicateOfId: d.duplicateBefore.duplicateOfId, updatedAt: now })
        .where(eq(openItems.id, d.duplicateId))
        .run();
      if (d.movedReminderIds.length) this.db.update(reminders).set({ targetId: d.duplicateId }).where(inArray(reminders.id, d.movedReminderIds)).run();
      if (d.createdRelationIds.length) this.db.delete(relations).where(inArray(relations.id, d.createdRelationIds)).run();
      if ('description' in d.keepBefore) this.graph.registerNode('task', d.keepId, keep.title, d.keepBefore.description ?? null);
      syncReminderAt(this.db, d.keepId);
      syncReminderAt(this.db, d.duplicateId);
    });
    void this.openItems.reindex(d.keepId);
    void this.openItems.reindex(d.duplicateId);
    this.ctx.events.changed('openItems', 'reminders', 'knowledge', 'status');
    return 'Zusammenführung der offenen Punkte rückgängig gemacht.';
  }
}
