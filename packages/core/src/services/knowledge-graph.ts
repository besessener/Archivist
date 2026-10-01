import type { EntityDetail, EntityType, GraphEntity, GraphRelation, RelationStatus, RelationType } from '@archivist/shared';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { decisions, documents, entities, events, openItems, relations } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { nameSimilarity, normalizeName } from '../util/text';
import type { AuditService } from './audit';
import type { UndoService } from './undo';

type EntityRow = typeof entities.$inferSelect;
type RelationRow = typeof relations.$inferSelect;

/** Audit undo type of merges (one audit entry per {@link KnowledgeGraphService.mergeMany} call). */
export const MERGE_UNDO_TYPE = 'entity.merge';
/** Named knowledge nodes that can be merged. Records (documents, decisions, …) are deduplicated differently. */
const MERGEABLE_TYPES = new Set<EntityType>(['topic', 'project', 'person', 'tag']);
const TOPIC_OR_PROJECT = new Set<string>(['topic', 'project']);

export interface MergeRequest {
  /** Entities that are merged into the target and removed afterwards. */
  sourceIds: string[];
  targetId: string;
  /** Allows merging a topic into a project or vice versa; the target's type wins. */
  allowCrossType?: boolean;
}

export interface MergeOptions {
  actor?: 'user' | 'agent';
  trigger?: string;
  /** Audit action name (default `entity.merge`). */
  action?: string;
}

export interface MergeResult {
  targetId: string;
  targetName: string;
  targetType: EntityType;
  mergedIds: string[];
  mergedNames: string[];
  relationsMoved: number;
  /** Records (documents, decisions, open items, events) whose references or name lists were changed. */
  referencesUpdated: number;
}

export interface MergeBatchResult {
  /** The single audit entry; undoing it reverts all merges of the batch. */
  auditId: string;
  results: MergeResult[];
}

/** Records whose search index entry must be rebuilt after a merge or its undo. */
export interface MergeReindexRefs {
  documents: string[];
  decisions: string[];
  openItems: string[];
  events: string[];
}
export type MergeReindexer = (refs: MergeReindexRefs) => Promise<void>;

type RefTableName = keyof MergeReindexRefs;
type RefTableShape = typeof events;
type RefRow = Record<string, string | string[] | null>;
type RefSets = Record<RefTableName, Set<string>>;

interface RefTableSpec {
  table: typeof documents | typeof decisions | typeof openItems | typeof events;
  /** German labels for conflict messages: definite / indefinite article. */
  the: string;
  a: string;
  /** Columns that a merge may change (plus updatedAt); also the fingerprint used for conflict detection. */
  cols: string[];
  /** Name-list column per entity type (stores names, not ids). */
  lists: Partial<Record<EntityType, string>>;
  responsible?: boolean;
}

const REF_TABLE_NAMES: RefTableName[] = ['documents', 'decisions', 'openItems', 'events'];
const REF_TABLES: Record<RefTableName, RefTableSpec> = {
  documents: {
    table: documents,
    the: 'Das Dokument',
    a: 'Ein Dokument',
    cols: ['topicId', 'projectId', 'persons', 'tags', 'updatedAt'],
    lists: { person: 'persons', tag: 'tags' },
  },
  decisions: {
    table: decisions,
    the: 'Die Entscheidung',
    a: 'Eine Entscheidung',
    cols: ['topicId', 'projectId', 'participants', 'updatedAt'],
    lists: { person: 'participants' },
  },
  openItems: {
    table: openItems,
    the: 'Der offene Punkt',
    a: 'Ein offener Punkt',
    cols: ['topicId', 'projectId', 'responsiblePersonId', 'updatedAt'],
    lists: {},
    responsible: true,
  },
  events: { table: events, the: 'Das Ereignis', a: 'Ein Ereignis', cols: ['topicId', 'projectId', 'updatedAt'], lists: {} },
};

/** Exact prior state of one merge (undo data). */
interface MergeStep {
  target: EntityRow;
  sources: EntityRow[];
  relationsDeleted: RelationRow[];
  relationsUpdated: RelationRow[];
  refs: Array<{ table: RefTableName; id: string; before: RefRow }>;
}
interface MergeUndoData {
  steps: MergeStep[];
  /** Fingerprints of every touched row right after the batch; any difference blocks the undo. */
  after: Record<string, string | null>;
}

const col = (tbl: RefTableShape, name: string): SQLiteColumn => (tbl as unknown as Record<string, SQLiteColumn>)[name]!;
const selection = (tbl: RefTableShape, cols: string[]): Record<string, SQLiteColumn> => Object.fromEntries(cols.map((c) => [c, col(tbl, c)]));
const emptyRefSets = (): RefSets => ({ documents: new Set(), decisions: new Set(), openItems: new Set(), events: new Set() });

/** Explicit user decisions win over proposals when two relations are combined. */
const STATUS_RANK: Record<string, number> = { confirmed: 3, rejected: 2, proposed: 1, outdated: 0 };
function combineRelations(a: RelationRow, b: RelationRow): Pick<RelationRow, 'status' | 'confidence' | 'sourceIds'> {
  return {
    status: (STATUS_RANK[b.status] ?? 0) > (STATUS_RANK[a.status] ?? 0) ? b.status : a.status,
    confidence: Math.max(a.confidence, b.confidence),
    sourceIds: [...new Set([...a.sourceIds, ...b.sourceIds])],
  };
}

/** Replaces names of merged entities by the canonical target name and removes resulting duplicates. */
function replaceNames(list: string[], from: Set<string>, to: string): string[] {
  if (!list.some((n) => from.has(normalizeName(n)))) return list;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of list) {
    const name = from.has(normalizeName(n)) ? to : n;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Clears topic/project slots that point to a merged entity and puts the target into the slot of its type. An occupied
 * slot (a different topic/project) is kept; the moved relation still links the record with the target.
 */
function rehangSlots(row: RefRow, sources: Set<string>, target: EntityRow): void {
  let hit = false;
  for (const slot of ['topicId', 'projectId'] as const) {
    const v = row[slot];
    if (typeof v === 'string' && sources.has(v)) {
      row[slot] = null;
      hit = true;
    }
  }
  const slot = target.type === 'topic' ? 'topicId' : 'projectId';
  if (hit && (row[slot] === null || row[slot] === target.id)) row[slot] = target.id;
}

function mergeAliases(row: Pick<EntityRow, 'normalizedName' | 'aliases'>, names: string[]): string[] {
  const seen = new Set([row.normalizedName, ...row.aliases.map(normalizeName)]);
  const out = [...row.aliases];
  for (const n of names) {
    const clean = n.trim().replace(/\s+/g, ' ');
    const key = normalizeName(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

const mapEntity = (r: EntityRow): GraphEntity => ({
  id: r.id,
  type: r.type as EntityType,
  name: r.name,
  description: r.description,
  aliases: r.aliases,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const mapRelation = (r: RelationRow): GraphRelation => ({
  id: r.id,
  sourceEntityId: r.sourceEntityId,
  targetEntityId: r.targetEntityId,
  relationType: r.relationType as RelationType,
  confidence: r.confidence,
  sourceIds: r.sourceIds,
  status: r.status as RelationStatus,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Wissensgraph über Entitäts- und Beziehungstabellen in SQLite. */
export class KnowledgeGraphService {
  private reindexer: MergeReindexer | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    undo: UndoService,
  ) {
    undo.register(MERGE_UNDO_TYPE, {
      check: async (data) => this.conflicts(data as MergeUndoData),
      run: (data) => this.undoMerge(data as MergeUndoData),
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  getEntity(id: string): GraphEntity | undefined {
    const r = this.db.select().from(entities).where(eq(entities.id, id)).get();
    return r ? mapEntity(r) : undefined;
  }

  /** Findet oder erzeugt eine benannte Entität (Thema, Projekt, Person …) anhand des normalisierten Namens. */
  ensureEntity(type: EntityType, name: string, description?: string | null): GraphEntity {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw new AppError('validation_error', 'Der Name darf nicht leer sein.');
    const norm = normalizeName(clean);
    const existing = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), eq(entities.normalizedName, norm)))
      .get();
    if (existing) return mapEntity(existing);
    const now = nowIso();
    const row: EntityRow = {
      id: newId(),
      type,
      name: clean,
      normalizedName: norm,
      description: description ?? null,
      aliases: [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(entities).values(row).run();
    this.ctx.events.changed('knowledge');
    return mapEntity(row);
  }

  findByName(type: EntityType, name: string): GraphEntity | undefined {
    const r = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), eq(entities.normalizedName, normalizeName(name))))
      .get();
    return r ? mapEntity(r) : undefined;
  }

  /** Registriert Dokumente/Entscheidungen/offene Punkte als Knoten mit eigener (vorgegebener) id. */
  registerNode(type: EntityType, id: string, name: string, description?: string | null): void {
    const now = nowIso();
    const norm = normalizeName(name);
    this.db
      .insert(entities)
      .values({ id, type, name, normalizedName: norm, description: description ?? null, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: entities.id, set: { name, normalizedName: norm, description: description ?? null, updatedAt: now } })
      .run();
  }

  removeNode(id: string): void {
    this.db
      .delete(relations)
      .where(or(eq(relations.sourceEntityId, id), eq(relations.targetEntityId, id)))
      .run();
    this.db.delete(entities).where(eq(entities.id, id)).run();
    this.ctx.events.changed('knowledge');
  }

  /**
   * Legt eine Beziehung an. Bereits abgelehnte Beziehungen werden nicht wiederbelebt,
   * bestätigte nie zurückgestuft.
   */
  link(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    opts: { confidence?: number; status?: RelationStatus; sourceIds?: string[] } = {},
  ): GraphRelation | null {
    if (sourceId === targetId) return null;
    const existing = this.db
      .select()
      .from(relations)
      .where(and(eq(relations.sourceEntityId, sourceId), eq(relations.targetEntityId, targetId), eq(relations.relationType, relationType)))
      .get();
    const now = nowIso();
    if (existing) {
      if (existing.status === 'rejected') return mapRelation(existing);
      const status = existing.status === 'confirmed' ? 'confirmed' : (opts.status ?? existing.status);
      const sourceIds = [...new Set([...existing.sourceIds, ...(opts.sourceIds ?? [])])];
      const confidence = Math.max(existing.confidence, opts.confidence ?? 0);
      this.db.update(relations).set({ status, sourceIds, confidence, updatedAt: now }).where(eq(relations.id, existing.id)).run();
      return mapRelation({ ...existing, status, sourceIds, confidence, updatedAt: now });
    }
    const row: RelationRow = {
      id: newId(),
      sourceEntityId: sourceId,
      targetEntityId: targetId,
      relationType,
      confidence: opts.confidence ?? 0.5,
      sourceIds: opts.sourceIds ?? [],
      status: opts.status ?? 'proposed',
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(relations).values(row).run();
    this.ctx.events.changed('knowledge');
    return mapRelation(row);
  }

  getRelation(id: string): GraphRelation | undefined {
    const r = this.db.select().from(relations).where(eq(relations.id, id)).get();
    return r ? mapRelation(r) : undefined;
  }

  deleteRelation(id: string): void {
    this.db.delete(relations).where(eq(relations.id, id)).run();
    this.ctx.events.changed('knowledge');
  }

  setRelationStatus(id: string, status: RelationStatus): GraphRelation {
    const r = this.getRelation(id);
    if (!r) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    this.db.update(relations).set({ status, updatedAt: nowIso() }).where(eq(relations.id, id)).run();
    this.ctx.events.changed('knowledge');
    return { ...r, status };
  }

  relationsOf(entityId: string, opts: { statuses?: RelationStatus[]; types?: RelationType[] } = {}): GraphRelation[] {
    const rows = this.db
      .select()
      .from(relations)
      .where(or(eq(relations.sourceEntityId, entityId), eq(relations.targetEntityId, entityId)))
      .all()
      .map(mapRelation);
    return rows.filter((r) => (!opts.statuses || opts.statuses.includes(r.status)) && (!opts.types || opts.types.includes(r.relationType)));
  }

  /** Entitäten, die über aktive (nicht abgelehnte) Beziehungen mit `entityId` verbunden sind. */
  neighbors(entityId: string, opts: { types?: EntityType[]; relationTypes?: RelationType[] } = {}): GraphEntity[] {
    const rels = this.relationsOf(entityId, { statuses: ['proposed', 'confirmed'], types: opts.relationTypes });
    const ids = [...new Set(rels.map((r) => (r.sourceEntityId === entityId ? r.targetEntityId : r.sourceEntityId)))];
    if (ids.length === 0) return [];
    const found = this.db.select().from(entities).where(inArray(entities.id, ids)).all().map(mapEntity);
    return opts.types ? found.filter((e) => opts.types!.includes(e.type)) : found;
  }

  listEntities(opts: { type?: EntityType; query?: string; limit?: number } = {}): Array<GraphEntity & { relationCount: number }> {
    const conds = [];
    if (opts.type) conds.push(eq(entities.type, opts.type));
    if (opts.query?.trim()) conds.push(like(entities.normalizedName, `%${normalizeName(opts.query)}%`));
    const rows = this.db
      .select()
      .from(entities)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(entities.name)
      .limit(opts.limit ?? 300)
      .all();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const counts = new Map<string, number>();
    const rel = this.db
      .select({ s: relations.sourceEntityId, t: relations.targetEntityId })
      .from(relations)
      .where(and(or(inArray(relations.sourceEntityId, ids), inArray(relations.targetEntityId, ids)), sql`${relations.status} != 'rejected'`))
      .all();
    for (const r of rel) {
      counts.set(r.s, (counts.get(r.s) ?? 0) + 1);
      counts.set(r.t, (counts.get(r.t) ?? 0) + 1);
    }
    return rows.map((r) => ({ ...mapEntity(r), relationCount: counts.get(r.id) ?? 0 }));
  }

  getDetail(id: string): EntityDetail {
    const entity = this.getEntity(id);
    if (!entity) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    const rels = this.relationsOf(id);
    const otherIds = [...new Set(rels.map((r) => (r.sourceEntityId === id ? r.targetEntityId : r.sourceEntityId)))];
    const others = otherIds.length
      ? new Map(
          this.db
            .select()
            .from(entities)
            .where(inArray(entities.id, otherIds))
            .all()
            .map((e) => [e.id, mapEntity(e)]),
        )
      : new Map<string, GraphEntity>();
    return {
      entity,
      relations: rels.flatMap((r) => {
        const out = r.sourceEntityId === id;
        const other = others.get(out ? r.targetEntityId : r.sourceEntityId);
        return other ? [{ ...r, direction: out ? ('out' as const) : ('in' as const), other }] : [];
      }),
    };
  }

  /** Paare ähnlich benannter Themen (Kandidaten für eine Zusammenführung). */
  findSimilarTopics(threshold = 0.82): Array<{ a: GraphEntity; b: GraphEntity; score: number }> {
    const topics = this.db.select().from(entities).where(eq(entities.type, 'topic')).all().map(mapEntity);
    const out: Array<{ a: GraphEntity; b: GraphEntity; score: number }> = [];
    for (let i = 0; i < topics.length; i += 1) {
      for (let j = i + 1; j < topics.length; j += 1) {
        const score = nameSimilarity(topics[i]!.name, topics[j]!.name);
        if (score >= threshold) out.push({ a: topics[i]!, b: topics[j]!, score });
      }
    }
    return out.sort((x, y) => y.score - x.score);
  }

  // ---------------------------------------------------------------------------------------------
  // Aliases
  // ---------------------------------------------------------------------------------------------

  /**
   * Finds an entity by its exact (normalized) name, otherwise by one of its aliases. An alias that belongs to
   * several entities of the type is ambiguous and yields `undefined`.
   */
  findByNameOrAlias(type: EntityType, name: string): GraphEntity | undefined {
    const exact = this.findByName(type, name);
    if (exact) return exact;
    const norm = normalizeName(name);
    if (!norm) return undefined;
    const hits = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), sql`${entities.aliases} != '[]'`))
      .all()
      .filter((r) => r.aliases.some((a) => normalizeName(a) === norm));
    return hits.length === 1 ? mapEntity(hits[0]!) : undefined;
  }

  /** Remembers `alias` as an alternative name of the entity (no-op if it equals the name or a known alias). */
  addAlias(entityId: string, alias: string): GraphEntity {
    const row = this.db.select().from(entities).where(eq(entities.id, entityId)).get();
    if (!row) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    const aliases = mergeAliases(row, [alias]);
    if (aliases.length === row.aliases.length) return mapEntity(row);
    const updatedAt = nowIso();
    this.db.update(entities).set({ aliases, updatedAt }).where(eq(entities.id, entityId)).run();
    this.ctx.events.changed('knowledge');
    return mapEntity({ ...row, aliases, updatedAt });
  }

  // ---------------------------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------------------------

  /** Sets the callback that rebuilds search index entries of records touched by a merge or its undo. */
  setReindexer(reindexer: MergeReindexer): void {
    this.reindexer = reindexer;
  }

  /** Merges one or more entities into a target (see {@link mergeMany}); one audit entry, undoable. */
  async merge(request: MergeRequest, opts: MergeOptions = {}): Promise<MergeResult & { auditId: string }> {
    const { auditId, results } = await this.mergeMany([request], opts);
    return { auditId, ...results[0]! };
  }

  /**
   * Performs several merges atomically and records them as ONE audit entry, so one undo reverts all of them.
   * Each merge re-hangs relations (status/confidence/sources are kept, duplicates combined), `topicId`/`projectId`
   * of documents, decisions, open items and events, responsible persons and the name lists `decisions.participants`,
   * `documents.persons` and `documents.tags` (canonical target name, deduplicated). Merged-away names become aliases
   * of the target; the affected records are reindexed afterwards.
   */
  async mergeMany(requests: MergeRequest[], opts: MergeOptions = {}): Promise<MergeBatchResult> {
    if (requests.length === 0) throw new AppError('validation_error', 'Zusammenführung: Keine Einträge angegeben.');
    const touched = new Set<string>();
    const reindex = emptyRefSets();
    const steps: MergeStep[] = [];
    const results: MergeResult[] = [];
    const auditId = this.ctx.database.transaction(() => {
      for (const req of requests) {
        const { step, result } = this.applyMerge(req, touched, reindex);
        steps.push(step);
        results.push(result);
      }
      const data: MergeUndoData = { steps, after: this.fingerprints([...touched]) };
      return this.audit.log({
        action: opts.action ?? 'entity.merge',
        actor: opts.actor ?? 'user',
        trigger: opts.trigger ?? 'manual',
        confirmed: true,
        entityIds: [...new Set(results.flatMap((r) => [...r.mergedIds, r.targetId]))],
        before: results.map((r) => ({ names: r.mergedNames, into: r.targetName })),
        after: results,
        undo: { type: MERGE_UNDO_TYPE, data },
      });
    });
    this.ctx.events.changed('knowledge', 'documents', 'decisions', 'openItems', 'events');
    await this.runReindex(reindex);
    return { auditId, results };
  }

  private entityRow(id: string): EntityRow | undefined {
    return this.db.select().from(entities).where(eq(entities.id, id)).get();
  }

  private validateMerge(req: MergeRequest): { target: EntityRow; sources: EntityRow[] } {
    const target = this.entityRow(req.targetId);
    if (!target) throw new AppError('validation_error', 'Zusammenführung: Zieleintrag nicht gefunden.');
    const sourceIds = [...new Set(req.sourceIds)].filter((id) => id !== target.id);
    if (sourceIds.length === 0) throw new AppError('validation_error', 'Zusammenführung: Keine Einträge zum Zusammenführen angegeben.');
    const sources = sourceIds.map((id) => {
      const row = this.entityRow(id);
      if (!row) throw new AppError('validation_error', 'Zusammenführung: Eintrag nicht gefunden.');
      return row;
    });
    for (const s of [target, ...sources]) {
      if (!MERGEABLE_TYPES.has(s.type as EntityType)) throw new AppError('validation_error', 'Diese Art von Eintrag kann nicht zusammengeführt werden.');
    }
    for (const s of sources) {
      if (s.type === target.type) continue;
      if (!(req.allowCrossType && TOPIC_OR_PROJECT.has(s.type) && TOPIC_OR_PROJECT.has(target.type)))
        throw new AppError('validation_error', 'Nur gleichartige Einträge können zusammengeführt werden.');
    }
    return { target, sources };
  }

  private applyMerge(req: MergeRequest, touched: Set<string>, reindex: RefSets): { step: MergeStep; result: MergeResult } {
    const { target, sources } = this.validateMerge(req);
    const sourceIds = sources.map((s) => s.id);
    const now = nowIso();
    const step: MergeStep = { target: { ...target }, sources, relationsDeleted: [], relationsUpdated: [], refs: [] };

    const relationsMoved = this.moveRelations(step, now, touched);
    const referencesUpdated = this.rehangReferences(step, now, touched, reindex);

    // the target keeps the merged names as aliases and takes over a missing description
    const aliases = mergeAliases(
      target,
      sources.flatMap((s) => [s.name, ...s.aliases]),
    );
    const description = target.description ?? sources.find((s) => s.description)?.description ?? null;
    this.db.update(entities).set({ aliases, description, updatedAt: now }).where(eq(entities.id, target.id)).run();
    touched.add(`entity:${target.id}`);

    this.db.delete(entities).where(inArray(entities.id, sourceIds)).run();
    for (const id of sourceIds) touched.add(`entity:${id}`);

    return {
      step,
      result: {
        targetId: target.id,
        targetName: target.name,
        targetType: target.type as EntityType,
        mergedIds: sourceIds,
        mergedNames: sources.map((s) => s.name),
        relationsMoved,
        referencesUpdated,
      },
    };
  }

  /** Moves relations of the sources to the target in place (ids are kept) or combines them with an existing one. */
  private moveRelations(step: MergeStep, now: string, touched: Set<string>): number {
    const targetId = step.target.id;
    const sourceIds = step.sources.map((s) => s.id);
    const sourceSet = new Set(sourceIds);
    const mapId = (id: string) => (sourceSet.has(id) ? targetId : id);
    const snapshotted = new Set<string>();
    const snapshot = (r: RelationRow) => {
      if (snapshotted.has(r.id)) return;
      snapshotted.add(r.id);
      step.relationsUpdated.push({ ...r });
    };
    let moved = 0;
    const rels = this.db
      .select()
      .from(relations)
      .where(or(inArray(relations.sourceEntityId, sourceIds), inArray(relations.targetEntityId, sourceIds)))
      .all();
    for (const r of rels) {
      const s = mapId(r.sourceEntityId);
      const t = mapId(r.targetEntityId);
      touched.add(`relation:${r.id}`);
      const existing =
        s === t
          ? undefined
          : this.db
              .select()
              .from(relations)
              .where(and(eq(relations.sourceEntityId, s), eq(relations.targetEntityId, t), eq(relations.relationType, r.relationType)))
              .get();
      if (s === t || existing) {
        // a relation between the merged entities themselves is dropped, a duplicate is combined into the existing one
        if (existing) {
          snapshot(existing);
          this.db
            .update(relations)
            .set({ ...combineRelations(existing, r), updatedAt: now })
            .where(eq(relations.id, existing.id))
            .run();
          touched.add(`relation:${existing.id}`);
        }
        this.db.delete(relations).where(eq(relations.id, r.id)).run();
        step.relationsDeleted.push({ ...r });
      } else {
        snapshot(r);
        this.db.update(relations).set({ sourceEntityId: s, targetEntityId: t, updatedAt: now }).where(eq(relations.id, r.id)).run();
      }
      if (s !== t) moved += 1;
    }
    return moved;
  }

  /** Re-hangs topic/project/responsible references and name lists in documents, decisions, open items and events. */
  private rehangReferences(step: MergeStep, now: string, touched: Set<string>, reindex: RefSets): number {
    const target = step.target;
    const sourceIds = step.sources.map((s) => s.id);
    const sourceSet = new Set(sourceIds);
    const sourceNames = new Set(step.sources.flatMap((s) => [s.normalizedName, ...s.aliases.map(normalizeName)]));
    const touchesTopics = step.sources.some((s) => TOPIC_OR_PROJECT.has(s.type));
    let updated = 0;
    for (const name of REF_TABLE_NAMES) {
      const spec = REF_TABLES[name];
      const tbl = spec.table as RefTableShape;
      const listCol = spec.lists[target.type as EntityType];
      const responsible = spec.responsible === true && target.type === 'person';
      const conds = [];
      if (touchesTopics) conds.push(inArray(tbl.topicId, sourceIds), inArray(tbl.projectId, sourceIds));
      if (responsible) conds.push(inArray(col(tbl, 'responsiblePersonId'), sourceIds));
      if (listCol) conds.push(sql`${col(tbl, listCol)} != '[]'`);
      if (conds.length === 0) continue;
      const rows = this.db
        .select(selection(tbl, ['id', ...spec.cols]))
        .from(tbl)
        .where(or(...conds))
        .all() as RefRow[];
      for (const row of rows) {
        const next: RefRow = { ...row };
        if (touchesTopics) rehangSlots(next, sourceSet, target);
        if (responsible && sourceSet.has(String(next.responsiblePersonId))) next.responsiblePersonId = target.id;
        if (listCol) next[listCol] = replaceNames(next[listCol] as string[], sourceNames, target.name);
        const changed = spec.cols.filter((c) => c !== 'updatedAt' && JSON.stringify(next[c]) !== JSON.stringify(row[c]));
        if (changed.length === 0) continue;
        const id = String(row.id);
        const before: RefRow = { updatedAt: row.updatedAt ?? null };
        const set: RefRow = { updatedAt: now };
        for (const c of changed) {
          before[c] = row[c] ?? null;
          set[c] = next[c] ?? null;
        }
        this.db.update(tbl).set(set).where(eq(tbl.id, id)).run();
        step.refs.push({ table: name, id, before });
        touched.add(`${name}:${id}`);
        reindex[name].add(id);
        updated += 1;
      }
    }
    return updated;
  }

  /** Serialized current state of the rows named by fingerprint keys (`entity:<id>`, `relation:<id>`, `<refTable>:<id>`). */
  private fingerprints(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const key of keys) out[key] = this.fingerprint(key);
    return out;
  }

  private fingerprint(key: string): string | null {
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);
    if (kind === 'entity') {
      const r = this.entityRow(id);
      return r ? JSON.stringify(r) : null;
    }
    if (kind === 'relation') {
      const r = this.db.select().from(relations).where(eq(relations.id, id)).get();
      return r ? JSON.stringify(r) : null;
    }
    const spec = REF_TABLES[kind as RefTableName];
    const tbl = spec.table as RefTableShape;
    const r = this.db.select(selection(tbl, spec.cols)).from(tbl).where(eq(tbl.id, id)).get();
    return r ? JSON.stringify(r) : null;
  }

  private conflicts(data: MergeUndoData): string[] {
    const out = new Set<string>();
    const restoring = new Set(data.steps.flatMap((s) => [s.target.id, ...s.sources.map((x) => x.id)]));
    for (const [key, expected] of Object.entries(data.after)) {
      if (this.fingerprint(key) === expected) continue;
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (kind === 'entity') {
        const known = data.steps.flatMap((s) => [s.target, ...s.sources]).find((e) => e.id === id);
        const label = known ? `„${known.name}“` : 'Ein Eintrag';
        if (expected === null) out.add(`${label} wurde seit der Zusammenführung wieder angelegt.`);
        else if (!this.entityRow(id)) out.add(`${label} wurde seit der Zusammenführung gelöscht.`);
        else out.add(`${label} wurde seit der Zusammenführung verändert.`);
      } else if (kind === 'relation') {
        out.add('Eine betroffene Beziehung wurde seit der Zusammenführung verändert oder gelöscht.');
      } else {
        const name = kind as RefTableName;
        const spec = REF_TABLES[name];
        const tbl = spec.table as RefTableShape;
        const row = this.db.select({ title: tbl.title }).from(tbl).where(eq(tbl.id, id)).get();
        out.add(row ? `${spec.the} „${row.title}“ wurde seit der Zusammenführung verändert.` : `${spec.a} wurde seit der Zusammenführung gelöscht.`);
      }
    }
    // a merged name was created again in the meantime (restoring it would produce a duplicate)
    for (const step of data.steps) {
      for (const s of step.sources) {
        const dup = this.db
          .select()
          .from(entities)
          .where(and(eq(entities.type, s.type), eq(entities.normalizedName, s.normalizedName)))
          .all()
          .find((e) => !restoring.has(e.id));
        if (dup) out.add(`„${dup.name}“ wurde seit der Zusammenführung neu angelegt. Bitte zuerst diesen Eintrag bereinigen.`);
      }
    }
    return [...out];
  }

  private async undoMerge(data: MergeUndoData): Promise<string> {
    const reindex = emptyRefSets();
    this.ctx.database.transaction(() => {
      for (const step of [...data.steps].reverse()) {
        this.db.insert(entities).values(step.sources).run();
        const { id: targetId, ...target } = step.target;
        this.db.update(entities).set(target).where(eq(entities.id, targetId)).run();
        for (const r of step.relationsUpdated) {
          const { id, ...rest } = r;
          this.db.update(relations).set(rest).where(eq(relations.id, id)).run();
        }
        if (step.relationsDeleted.length) this.db.insert(relations).values(step.relationsDeleted).run();
        for (const ref of step.refs) {
          const tbl = REF_TABLES[ref.table].table as RefTableShape;
          this.db.update(tbl).set(ref.before).where(eq(tbl.id, ref.id)).run();
          reindex[ref.table].add(ref.id);
        }
      }
    });
    this.ctx.events.changed('knowledge', 'documents', 'decisions', 'openItems', 'events');
    await this.runReindex(reindex);
    const names = data.steps.flatMap((s) => s.sources.map((x) => `„${x.name}“`));
    return `Zusammenführung rückgängig gemacht: ${names.join(', ')} wiederhergestellt.`;
  }

  private async runReindex(refs: RefSets): Promise<void> {
    if (!this.reindexer) return;
    try {
      await this.reindexer({
        documents: [...refs.documents],
        decisions: [...refs.decisions],
        openItems: [...refs.openItems],
        events: [...refs.events],
      });
    } catch (err) {
      this.ctx.logger.warn('knowledge', 'Neuindexierung nach Zusammenführung fehlgeschlagen', { error: err });
    }
  }
}
