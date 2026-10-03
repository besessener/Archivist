import type { EntityRef, OpenItem } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { openItems, relations, reminders } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { tokenize, truncate } from '../../util/text';
import type { AuditService } from '../audit';
import type { InsightInput, InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import { ACTIVE_STATUSES, type OpenItemService } from '../open-items';
import { syncReminderAt } from '../reminders';
import type { UndoService } from '../undo';
import { assessOpenItemPair, type DuplicateAssessment } from './open-item-assessment';
import { chooseKept, duplicatePairKey, takeOverMissing, type TakeOverRules } from './record-merge';

export { findOpenItemDuplicate } from './open-item-assessment';

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

/** Cheap pre-filter: two titles can only match if they share a word stem (first three letters). */
const stems = (title: string) => new Set(tokenize(title).map((token) => token.slice(0, 3)));

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

type Origin = { actor?: 'user' | 'agent'; trigger?: string };

/** The kept item's new values; a filled due date or responsible person is no longer „unknown“. */
function mergedColumns(keep: Row, duplicate: Row) {
  const { patch, before, fields } = takeOverMissing({ keep, duplicate }, TAKE_OVER);
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
  return { patch, set, keepBefore, fields };
}

function duplicateInsight(pair: DuplicatePair & { key: string; takenOver: string[] }): InsightInput {
  const { keep, duplicate, assessment, takenOver } = pair;
  const similarity = `Titel/Beschreibung ${Math.round(assessment.similarity * 100)} %${assessment.reasons.length ? `, ${assessment.reasons.join(', ')}` : ''}`;
  const affected: EntityRef[] = [
    { type: 'task', id: keep.id, label: keep.title },
    { type: 'task', id: duplicate.id, label: duplicate.title },
  ];
  return {
    kind: 'duplicate',
    title: `Doppelter offener Punkt: „${truncate(keep.title, 70)}“`,
    explanation: [
      `„${keep.title}“ und „${duplicate.title}“ beschreiben vermutlich dieselbe Aufgabe (${similarity}).`,
      `Vorschlag: „${keep.title}“ (zuerst erfasst) behalten${takenOver.length ? `, fehlende Angaben übernehmen (${takenOver.join(', ')})` : ''} und „${duplicate.title}“ als „verworfen (Duplikat)“ markieren.`,
      'Es wird nichts gelöscht, und die Zusammenführung lässt sich rückgängig machen. Sind es verschiedene Punkte, lehne den Hinweis ab – er erscheint dann nicht wieder.',
    ].join('\n\n'),
    confidence: Math.min(0.95, assessment.score),
    affected,
    sourceIds: [keep.id, duplicate.id],
    action: {
      proposal: {
        actionType: 'merge_open_items',
        label: `„${truncate(duplicate.title, 60)}“ als Duplikat von „${truncate(keep.title, 60)}“ verwerfen`,
        rationale: `Die offenen Punkte ähneln sich (${similarity}).`,
        confidence: Math.min(0.95, assessment.score),
        affectedEntities: affected,
        requiredConfirmation: 'confirm',
        proposedParameters: { keepId: keep.id, duplicateId: duplicate.id },
      },
      label: 'Zusammenführen',
    },
    dedupeKey: pair.key,
  };
}

export interface OpenItemDuplicateServiceDeps {
  ctx: AppContext;
  openItems: OpenItemService;
  graph: KnowledgeGraphService;
  audit: AuditService;
  undo: UndoService;
  insights: InsightService;
}

/** Duplicate open items: the archive check proposes keeping the first one and discarding the other (undoable, never deleted). */
export class OpenItemDuplicateService {
  private readonly ctx: AppContext;
  private readonly openItems: OpenItemService;
  private readonly graph: KnowledgeGraphService;
  private readonly audit: AuditService;
  private readonly insights: InsightService;

  constructor(deps: OpenItemDuplicateServiceDeps) {
    ({ ctx: this.ctx, openItems: this.openItems, graph: this.graph, audit: this.audit, insights: this.insights } = deps);
    const { undo } = deps;
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
        if (![...a.stems].some((stem) => b.stems.has(stem))) continue;
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
    for (const pair of this.findPairs()) {
      const key = duplicatePairKey(OPEN_ITEM_DUPLICATE_KEY_PREFIX, [pair.keep.id, pair.duplicate.id]);
      keepKeys.add(key);
      // a rejected hint („Verschieden“) stays rejected: upsert neither reopens it nor proposes its action again
      this.insights.upsert(duplicateInsight({ ...pair, key, takenOver: this.takenOverLabels(pair) }));
      count?.('duplicate_open_item');
      found += 1;
    }
    // hints whose cause is gone are removed (their proposals withdrawn); „Verschieden“ is kept while both items exist
    for (const key of this.rememberedDifferent()) keepKeys.add(key);
    this.insights.reconcile(OPEN_ITEM_DUPLICATE_KEY_PREFIX, keepKeys);
    return found;
  }

  private takenOverLabels({ keep, duplicate }: DuplicatePair): string[] {
    const fields = takeOverMissing({ keep: this.row(keep.id)!, duplicate: this.row(duplicate.id)! }, TAKE_OVER).fields.map(
      (field) => FIELD_LABELS[field] ?? field,
    );
    if (this.pendingReminders(duplicate.id).length) fields.push('Erinnerungen');
    return fields;
  }

  /** Keys of pairs rejected as different while both items exist; they stay remembered even when no longer detected. */
  private rememberedDifferent(): string[] {
    const keys: string[] = [];
    for (const insight of this.insights.list('rejected')) {
      if (insight.kind !== 'duplicate' || insight.sourceIds.length !== 2) continue;
      const [a, b] = insight.sourceIds as [string, string];
      if (this.row(a) && this.row(b)) keys.push(duplicatePairKey(OPEN_ITEM_DUPLICATE_KEY_PREFIX, [a, b]));
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
  private linkNew(
    link: { from: string; to: string; type: 'relates_to' | 'belongs_to' | 'results_from' | 'responsible_for' },
    opts: { confidence: number; sourceIds: string[] },
  ): string[] {
    const exists = this.db
      .select({ id: relations.id })
      .from(relations)
      .where(and(eq(relations.sourceEntityId, link.from), eq(relations.targetEntityId, link.to), eq(relations.relationType, link.type)))
      .get();
    const relation = this.graph.link(link.from, link.to, link.type, { confidence: opts.confidence, status: 'confirmed', sourceIds: opts.sourceIds });
    return !exists && relation ? [relation.id] : [];
  }

  /** Links for the details the kept item took over; returns the ids of relations that did not exist before. */
  private linkTakenOver(keep: Row, patch: Partial<Row>): string[] {
    const options = { confidence: keep.confidence, sourceIds: patch.sourceIds ?? keep.sourceIds };
    const created = [
      ...(patch.topicId ? this.linkNew({ from: keep.id, to: patch.topicId, type: 'relates_to' }, options) : []),
      ...(patch.projectId ? this.linkNew({ from: keep.id, to: patch.projectId, type: 'belongs_to' }, options) : []),
      ...(patch.responsiblePersonId ? this.linkNew({ from: patch.responsiblePersonId, to: keep.id, type: 'responsible_for' }, options) : []),
    ];
    for (const sourceId of (patch.sourceIds ?? []).filter((id) => !keep.sourceIds.includes(id))) {
      const type = this.graph.getEntity(sourceId)?.type;
      if (type === 'decision' || type === 'document')
        created.push(...this.linkNew({ from: keep.id, to: sourceId, type: 'results_from' }, { confidence: keep.confidence, sourceIds: [sourceId] }));
    }
    return created;
  }

  /** Why `keepId` and `duplicateId` can no longer be merged (null: they can) – also re-checked before a proposal runs. */
  staleReason(keepId: string, duplicateId: string): string | null {
    if (keepId === duplicateId) return 'Ein offener Punkt kann nicht mit sich selbst zusammengeführt werden.';
    const keep = this.row(keepId);
    const duplicate = this.row(duplicateId);
    if (!keep || !duplicate) return 'Offener Punkt nicht gefunden.';
    if (!ACTIVE_STATUSES.includes(keep.status as OpenItem['status']) || !ACTIVE_STATUSES.includes(duplicate.status as OpenItem['status']))
      return 'Nur aktive offene Punkte können zusammengeführt werden.';
    return null;
  }

  /** Keeps `keepId`, takes over what it lacks (reminders moved too) and dismisses the duplicate; one undoable audit entry. */
  merge(keepId: string, duplicateId: string, origin: Origin = {}): OpenItemMergeResult {
    const stale = this.staleReason(keepId, duplicateId);
    if (stale) throw new AppError('validation_error', stale);
    const keep = this.row(keepId)!;
    const duplicate = this.row(duplicateId)!;
    const columns = mergedColumns(keep, duplicate);
    const moved = this.pendingReminders(duplicate.id).map((reminder) => reminder.id);
    const auditId = this.ctx.database.transaction(() => this.writeMerge({ keep, duplicate, columns, moved, origin }));
    void this.openItems.reindex(keep.id);
    void this.openItems.reindex(duplicate.id);
    this.ctx.events.changed('openItems', 'reminders', 'knowledge', 'status');
    const takenOver = columns.fields.map((field) => FIELD_LABELS[field] ?? field);
    if (moved.length) takenOver.push('Erinnerungen');
    return { auditId, keep: this.openItems.get(keep.id), duplicate: this.openItems.get(duplicate.id), takenOver };
  }

  private writeMerge(input: { keep: Row; duplicate: Row; columns: ReturnType<typeof mergedColumns>; moved: string[]; origin: Origin }): string {
    const { keep, duplicate, moved, origin } = input;
    const { patch, set, keepBefore } = input.columns;
    const now = nowIso();
    this.db
      .update(openItems)
      .set({ ...set, updatedAt: now })
      .where(eq(openItems.id, keep.id))
      .run();
    this.db.update(openItems).set({ status: 'dismissed', duplicateOfId: keep.id, updatedAt: now }).where(eq(openItems.id, duplicate.id)).run();
    if (moved.length) this.db.update(reminders).set({ targetId: keep.id }).where(inArray(reminders.id, moved)).run();
    syncReminderAt(this.db, keep.id);
    syncReminderAt(this.db, duplicate.id);
    if (patch.description !== undefined) this.graph.registerNode('task', keep.id, keep.title, patch.description);
    const data: MergeUndoData = {
      keepId: keep.id,
      duplicateId: duplicate.id,
      keepBefore,
      duplicateBefore: { status: duplicate.status, duplicateOfId: duplicate.duplicateOfId },
      movedReminderIds: moved,
      createdRelationIds: this.linkTakenOver(keep, patch),
      keepUpdatedAt: now,
      duplicateUpdatedAt: now,
    };
    return this.audit.log({
      action: 'open_item.merge_duplicate',
      actor: origin.actor ?? 'user',
      trigger: origin.trigger ?? 'manual',
      confirmed: true,
      entityIds: [keep.id, duplicate.id],
      before: { keep: keepBefore, duplicate: data.duplicateBefore },
      after: { keep: set, duplicate: { status: 'dismissed', duplicateOfId: keep.id }, reminders: moved },
      undo: { type: OPEN_ITEM_MERGE_UNDO_TYPE, data },
    });
  }

  private undoConflicts(undoData: MergeUndoData): string[] {
    const keep = this.row(undoData.keepId);
    const duplicate = this.row(undoData.duplicateId);
    if (!keep || !duplicate) return ['Einer der zusammengeführten offenen Punkte existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (keep.updatedAt !== undoData.keepUpdatedAt) conflicts.push(`Der behaltene Punkt „${keep.title}“ wurde seit der Zusammenführung verändert.`);
    if (duplicate.updatedAt !== undoData.duplicateUpdatedAt)
      conflicts.push(`Der als Duplikat verworfene Punkt „${duplicate.title}“ wurde seit der Zusammenführung verändert.`);
    if (this.remindersMovedAway(undoData)) conflicts.push('Eine übernommene Erinnerung wurde seitdem gelöscht oder einem anderen Punkt zugeordnet.');
    return conflicts;
  }

  private remindersMovedAway(undoData: MergeUndoData): boolean {
    if (!undoData.movedReminderIds.length) return false;
    const still = this.db
      .select({ id: reminders.id, targetId: reminders.targetId })
      .from(reminders)
      .where(inArray(reminders.id, undoData.movedReminderIds))
      .all();
    return still.length !== undoData.movedReminderIds.length || still.some((reminder) => reminder.targetId !== undoData.keepId);
  }

  private undoMerge(undoData: MergeUndoData): string {
    const now = nowIso();
    const keep = this.row(undoData.keepId)!;
    this.ctx.database.transaction(() => {
      this.db
        .update(openItems)
        .set({ ...undoData.keepBefore, updatedAt: now })
        .where(eq(openItems.id, undoData.keepId))
        .run();
      this.db
        .update(openItems)
        .set({ status: undoData.duplicateBefore.status, duplicateOfId: undoData.duplicateBefore.duplicateOfId, updatedAt: now })
        .where(eq(openItems.id, undoData.duplicateId))
        .run();
      if (undoData.movedReminderIds.length)
        this.db.update(reminders).set({ targetId: undoData.duplicateId }).where(inArray(reminders.id, undoData.movedReminderIds)).run();
      if (undoData.createdRelationIds.length) this.db.delete(relations).where(inArray(relations.id, undoData.createdRelationIds)).run();
      if ('description' in undoData.keepBefore) this.graph.registerNode('task', undoData.keepId, keep.title, undoData.keepBefore.description ?? null);
      syncReminderAt(this.db, undoData.keepId);
      syncReminderAt(this.db, undoData.duplicateId);
    });
    void this.openItems.reindex(undoData.keepId);
    void this.openItems.reindex(undoData.duplicateId);
    this.ctx.events.changed('openItems', 'reminders', 'knowledge', 'status');
    return 'Zusammenführung der offenen Punkte rückgängig gemacht.';
  }
}
