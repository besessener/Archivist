import type { EntityType } from '@archivist/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, relations } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { normalizeName } from '../../util/text';
import type { AuditService } from '../audit';
import type { UndoService } from '../undo';
import { fingerprints, rehangReferences, TOPIC_OR_PROJECT } from './merge-references';
import {
  emptyRefSets,
  MERGE_UNDO_TYPE,
  type MergeBatchResult,
  type MergeLedger,
  type MergeOptions,
  type MergeReindexer,
  type MergeRequest,
  type MergeResult,
  type MergeStep,
  type MergeUndoData,
  type RefSets,
  type StepContext,
} from './merge-types';
import { mergeConflicts, mergeUndoneMessage, restoreMerges } from './merge-undo';
import { collapseWhitespace, mergeAliases, mergeRoles } from './names';
import { entityRow, type EntityRow, type RelationRow } from './rows';

/** Named knowledge nodes that can be merged. Records (documents, decisions, …) are deduplicated differently. */
const MERGEABLE_TYPES = new Set<string>(['topic', 'project', 'person', 'tag']);

/** Explicit user decisions win when two relations are combined: a `resolvedByUser` status beats a system one. */
const STATUS_RANK: Record<string, number> = { confirmed: 3, rejected: 2, proposed: 1, outdated: 0 };
function combineRelations(a: RelationRow, b: RelationRow): Pick<RelationRow, 'status' | 'confidence' | 'sourceIds' | 'resolvedByUser'> {
  const rank = (row: RelationRow) => (row.resolvedByUser ? 10 : 0) + (STATUS_RANK[row.status] ?? 0);
  return {
    status: rank(b) > rank(a) ? b.status : a.status,
    resolvedByUser: a.resolvedByUser || b.resolvedByUser,
    confidence: Math.max(a.confidence, b.confidence),
    sourceIds: [...new Set([...a.sourceIds, ...b.sourceIds])],
  };
}

const CHANGED_SCOPES = ['knowledge', 'documents', 'decisions', 'openItems', 'events'] as const;

export interface EntityMergesDeps {
  ctx: AppContext;
  audit: AuditService;
  undo: UndoService;
}

/** Merging and renaming named entities with exact, conflict-checked undo. */
export class EntityMerges {
  private reindexer: MergeReindexer = async () => {};

  private readonly ctx: AppContext;
  private readonly audit: AuditService;

  constructor(deps: EntityMergesDeps) {
    ({ ctx: this.ctx, audit: this.audit } = deps);
    const { undo } = deps;
    undo.register(MERGE_UNDO_TYPE, {
      check: async (data) => mergeConflicts(this.db, data as MergeUndoData),
      run: (data) => this.undoMerge(data as MergeUndoData),
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  setReindexer(reindexer: MergeReindexer): void {
    this.reindexer = reindexer;
  }

  /** Performs several merges atomically as ONE audit entry, so one undo reverts all of them; reindexes the records touched. */
  async mergeMany(requests: MergeRequest[], options: MergeOptions): Promise<MergeBatchResult> {
    if (requests.length === 0) throw new AppError('validation_error', 'Zusammenführung: Keine Einträge angegeben.');
    const ledger: MergeLedger = { touched: new Set(), reindex: emptyRefSets() };
    const steps: MergeStep[] = [];
    const results: MergeResult[] = [];
    const auditId = this.ctx.database.transaction(() => {
      for (const request of requests) {
        const { step, result } = this.applyMerge(request, ledger);
        steps.push(step);
        results.push(result);
      }
      const data: MergeUndoData = { steps, after: fingerprints(this.db, [...ledger.touched]) };
      return this.audit.log({
        action: options.action ?? 'entity.merge',
        actor: options.actor ?? 'user',
        trigger: options.trigger ?? 'manual',
        confirmed: true,
        entityIds: [...new Set(results.flatMap((result) => [...result.mergedIds, result.targetId]))],
        before: results.map((result) => ({ names: result.mergedNames, into: result.targetName })),
        after: results,
        undo: { type: MERGE_UNDO_TYPE, data },
      });
    });
    this.ctx.events.changed(...CHANGED_SCOPES);
    await this.runReindex(ledger.reindex);
    return { auditId, results };
  }

  /** Renames an entity and the name lists that mention it; recorded like a merge without sources. */
  async rename(request: { id: string; name: string }, options: MergeOptions & { keepOldName?: boolean }): Promise<{ auditId: string } | null> {
    const { id } = request;
    const target = entityRow(this.db, id);
    if (!target) throw new AppError('validation_error', 'Umbenennen: Eintrag nicht gefunden.');
    const clean = collapseWhitespace(request.name);
    if (!clean) throw new AppError('validation_error', 'Der Name darf nicht leer sein.');
    if (clean === target.name) return null;
    const ledger: MergeLedger = { touched: new Set([`entity:${id}`]), reindex: emptyRefSets() };
    const auditId = this.ctx.database.transaction(() => {
      const now = nowIso();
      const step: MergeStep = { target: { ...target }, sources: [], relationsDeleted: [], relationsUpdated: [], refs: [] };
      rehangReferences(this.db, { change: { step, now, ledger }, newName: clean });
      const normalizedName = normalizeName(clean);
      const aliases = options.keepOldName === false ? target.aliases : mergeAliases({ normalizedName, aliases: target.aliases }, [target.name]);
      this.db.update(entities).set({ name: clean, normalizedName, aliases, updatedAt: now }).where(eq(entities.id, id)).run();
      const data: MergeUndoData = { steps: [step], after: fingerprints(this.db, [...ledger.touched]) };
      return this.audit.log({
        action: options.action ?? 'entity.rename',
        actor: options.actor ?? 'user',
        trigger: options.trigger ?? 'manual',
        confirmed: true,
        entityIds: [id],
        before: { name: target.name },
        after: { name: clean },
        undo: { type: MERGE_UNDO_TYPE, data },
      });
    });
    this.ctx.events.changed(...CHANGED_SCOPES);
    await this.runReindex(ledger.reindex);
    return { auditId };
  }

  private validateMerge(request: MergeRequest): { target: EntityRow; sources: EntityRow[] } {
    const target = entityRow(this.db, request.targetId);
    if (!target) throw new AppError('validation_error', 'Zusammenführung: Zieleintrag nicht gefunden.');
    const sourceIds = [...new Set(request.sourceIds)].filter((id) => id !== target.id);
    if (sourceIds.length === 0) throw new AppError('validation_error', 'Zusammenführung: Keine Einträge zum Zusammenführen angegeben.');
    const sources = sourceIds.map((id) => {
      const row = entityRow(this.db, id);
      if (!row) throw new AppError('validation_error', 'Zusammenführung: Eintrag nicht gefunden.');
      return row;
    });
    if ([target, ...sources].some((entity) => !MERGEABLE_TYPES.has(entity.type)))
      throw new AppError('validation_error', 'Diese Art von Eintrag kann nicht zusammengeführt werden.');
    const crossTypeAllowed = (source: EntityRow) => request.allowCrossType && TOPIC_OR_PROJECT.has(source.type) && TOPIC_OR_PROJECT.has(target.type);
    if (sources.some((source) => source.type !== target.type && !crossTypeAllowed(source)))
      throw new AppError('validation_error', 'Nur gleichartige Einträge können zusammengeführt werden.');
    return { target, sources };
  }

  private applyMerge(request: MergeRequest, ledger: MergeLedger): { step: MergeStep; result: MergeResult } {
    const { target, sources } = this.validateMerge(request);
    const sourceIds = sources.map((source) => source.id);
    const now = nowIso();
    const step: MergeStep = { target: { ...target }, sources, relationsDeleted: [], relationsUpdated: [], refs: [] };
    const name = (request.targetName && collapseWhitespace(request.targetName)) || target.name;
    const renamed = name !== target.name;
    const change: StepContext = { step, now, ledger };
    const relationsMoved = this.moveRelations(change);
    const referencesUpdated = rehangReferences(this.db, { change, newName: renamed ? name : undefined });
    // the target keeps the merged names (and its former name) as aliases and takes over a missing description
    const normalizedName = normalizeName(name);
    const aliases = mergeAliases({ normalizedName, aliases: target.aliases }, [
      ...(renamed ? [target.name] : []),
      ...sources.flatMap((source) => [source.name, ...source.aliases]),
    ]);
    const description = target.description ?? sources.find((source) => source.description)?.description ?? null;
    const roles = mergeRoles(target.roles, [...sources.flatMap((source) => source.roles), ...(request.addRoles ?? [])]);
    this.db.update(entities).set({ name, normalizedName, aliases, roles, description, updatedAt: now }).where(eq(entities.id, target.id)).run();
    ledger.touched.add(`entity:${target.id}`);
    this.db.delete(entities).where(inArray(entities.id, sourceIds)).run();
    for (const id of sourceIds) ledger.touched.add(`entity:${id}`);
    const result: MergeResult = {
      targetId: target.id,
      targetName: name,
      targetType: target.type as EntityType,
      mergedIds: sourceIds,
      mergedNames: sources.map((source) => source.name),
      relationsMoved,
      referencesUpdated,
    };
    return { step, result };
  }

  /** Moves relations of the sources to the target in place (ids are kept) or combines them with an existing one. */
  private moveRelations(change: StepContext): number {
    const { step, ledger } = change;
    const sourceIds = step.sources.map((source) => source.id);
    const sourceSet = new Set(sourceIds);
    const mapId = (id: string) => (sourceSet.has(id) ? step.target.id : id);
    const snapshotted = new Set<string>();
    const snapshot = (row: RelationRow) => {
      if (snapshotted.has(row.id)) return;
      snapshotted.add(row.id);
      step.relationsUpdated.push({ ...row });
    };
    const rows = this.db
      .select()
      .from(relations)
      .where(or(inArray(relations.sourceEntityId, sourceIds), inArray(relations.targetEntityId, sourceIds)))
      .all();
    let moved = 0;
    for (const row of rows) {
      const ends = { source: mapId(row.sourceEntityId), target: mapId(row.targetEntityId) };
      ledger.touched.add(`relation:${row.id}`);
      if (ends.source === ends.target) {
        // a relation between the merged entities themselves is dropped
        this.dropRelation(row, step);
        continue;
      }
      moved += 1;
      const existing = this.db
        .select()
        .from(relations)
        .where(and(eq(relations.sourceEntityId, ends.source), eq(relations.targetEntityId, ends.target), eq(relations.relationType, row.relationType)))
        .get();
      if (existing) {
        // a duplicate is combined into the existing relation
        snapshot(existing);
        this.db
          .update(relations)
          .set({ ...combineRelations(existing, row), updatedAt: change.now })
          .where(eq(relations.id, existing.id))
          .run();
        ledger.touched.add(`relation:${existing.id}`);
        this.dropRelation(row, step);
        continue;
      }
      snapshot(row);
      this.db.update(relations).set({ sourceEntityId: ends.source, targetEntityId: ends.target, updatedAt: change.now }).where(eq(relations.id, row.id)).run();
    }
    return moved;
  }

  private dropRelation(row: RelationRow, step: MergeStep): void {
    this.db.delete(relations).where(eq(relations.id, row.id)).run();
    step.relationsDeleted.push({ ...row });
  }

  private async undoMerge(data: MergeUndoData): Promise<string> {
    const reindex = restoreMerges(this.ctx, data);
    this.ctx.events.changed(...CHANGED_SCOPES);
    await this.runReindex(reindex);
    return mergeUndoneMessage(data);
  }

  private async runReindex(refs: RefSets): Promise<void> {
    try {
      await this.reindexer({
        documents: [...refs.documents],
        decisions: [...refs.decisions],
        openItems: [...refs.openItems],
        events: [...refs.events],
      });
    } catch (err) {
      this.ctx.logger.warn('knowledge', 'Reindexing after merge failed', { error: err });
    }
  }
}
