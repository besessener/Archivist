import type { EntityDetail, EntityType, GraphEntity, GraphRelation, RelationStatus, RelationType } from '@archivist/shared';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions, documents, entities, openItems, relations } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { nameSimilarity, normalizeName } from '../util/text';

type EntityRow = typeof entities.$inferSelect;
type RelationRow = typeof relations.$inferSelect;

const mapEntity = (r: EntityRow): GraphEntity => ({
  id: r.id,
  type: r.type as EntityType,
  name: r.name,
  description: r.description,
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

/** Mutable state of a relation that field sync may change (restored on undo). */
export interface RelationState {
  status: RelationStatus;
  confidence: number;
  sourceIds: string[];
}

/**
 * Relation changes caused by one edit, stored in the edit's undo data:
 * relations the edit created (deleted again on undo) and relations whose state it changed.
 */
export interface RelationChangeSet {
  created: Array<{ id: string; status: RelationStatus }>;
  changed: Array<{ id: string; before: RelationState; after: RelationState }>;
}

const stateOf = (r: RelationRow): RelationState => ({ status: r.status as RelationStatus, confidence: r.confidence, sourceIds: r.sourceIds });
const sameState = (a: RelationState, b: RelationState) =>
  a.status === b.status && a.confidence === b.confidence && JSON.stringify(a.sourceIds) === JSON.stringify(b.sourceIds);

/** Statuses that count as a current, visible assignment. */
const ACTIVE_STATUSES: RelationStatus[] = ['proposed', 'confirmed'];

/** Wissensgraph über Entitäts- und Beziehungstabellen in SQLite. */
export class KnowledgeGraphService {
  constructor(private readonly ctx: AppContext) {}

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
    const row: EntityRow = { id: newId(), type, name: clean, normalizedName: norm, description: description ?? null, createdAt: now, updatedAt: now };
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
    opts: { confidence?: number; status?: RelationStatus; sourceIds?: string[]; resolvedByUser?: boolean } = {},
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
      // user decisions are kept; an outdated relation becomes current again when it is linked anew
      const status = existing.resolvedByUser
        ? existing.status
        : existing.status === 'confirmed'
          ? 'confirmed'
          : existing.status === 'outdated'
            ? (opts.status ?? 'proposed')
            : (opts.status ?? existing.status);
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
      resolvedByUser: opts.resolvedByUser ?? false,
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

  /** Sets the status as a user decision (`by: 'user'`), which field sync never overrides afterwards. */
  setRelationStatus(id: string, status: RelationStatus, by: 'user' | 'system' = 'user'): GraphRelation {
    const r = this.getRelation(id);
    if (!r) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    this.db
      .update(relations)
      .set({ status, updatedAt: nowIso(), ...(by === 'user' ? { resolvedByUser: true } : {}) })
      .where(eq(relations.id, id))
      .run();
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
    const rels = this.relationsOf(entityId, { statuses: ACTIVE_STATUSES, types: opts.relationTypes });
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
      .where(and(or(inArray(relations.sourceEntityId, ids), inArray(relations.targetEntityId, ids)), sql`${relations.status} NOT IN ('rejected', 'outdated')`))
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
    // outdated relations are history only: the detail view shows current assignments (and user rejections)
    const rels = this.relationsOf(id).filter((r) => r.status !== 'outdated');
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

  /**
   * Marks system-maintained relations of `relationType` between `entityId` and other entities as `outdated`,
   * except those to `keepIds`. Used when a field (topic, project, participants …) changes so the graph only
   * shows the current assignment. `direction: 'out'` (default) means `entityId` is the relation source,
   * `'in'` that it is the target. `otherType` restricts the other end (e.g. only topics, not tags).
   * Relations the user confirmed or rejected, rejected and already outdated ones stay untouched.
   * Returns the ids of the relations marked outdated.
   */
  unlinkSystemRelations(
    entityId: string,
    relationType: RelationType,
    keepIds: readonly string[],
    opts: { direction?: 'out' | 'in'; otherType?: EntityType } = {},
  ): string[] {
    const out = (opts.direction ?? 'out') === 'out';
    const rows = this.db
      .select()
      .from(relations)
      .where(
        and(
          eq(out ? relations.sourceEntityId : relations.targetEntityId, entityId),
          eq(relations.relationType, relationType),
          inArray(relations.status, ACTIVE_STATUSES),
          eq(relations.resolvedByUser, false),
        ),
      )
      .all()
      .filter((r) => !keepIds.includes(out ? r.targetEntityId : r.sourceEntityId));
    const otherIds = rows.map((r) => (out ? r.targetEntityId : r.sourceEntityId));
    const typeOf = new Map(
      opts.otherType && otherIds.length
        ? this.db
            .select({ id: entities.id, type: entities.type })
            .from(entities)
            .where(inArray(entities.id, otherIds))
            .all()
            .map((e) => [e.id, e.type])
        : [],
    );
    const stale = rows.filter((r) => !opts.otherType || typeOf.get(out ? r.targetEntityId : r.sourceEntityId) === opts.otherType);
    if (stale.length === 0) return [];
    const ids = stale.map((r) => r.id);
    this.db.update(relations).set({ status: 'outdated', updatedAt: nowIso() }).where(inArray(relations.id, ids)).run();
    this.ctx.events.changed('knowledge');
    return ids;
  }

  /**
   * Runs `fn` and records how the relations touching `entityId` changed (created / state changed),
   * so an edit's undo can restore the previous relations with `revertRelationChanges`.
   */
  trackRelationChanges<T>(entityId: string, fn: () => T): { result: T; changes: RelationChangeSet } {
    const before = new Map(this.relationRowsOf(entityId).map((r) => [r.id, r]));
    const result = fn();
    const changes: RelationChangeSet = { created: [], changed: [] };
    for (const r of this.relationRowsOf(entityId)) {
      const prev = before.get(r.id);
      if (!prev) changes.created.push({ id: r.id, status: r.status as RelationStatus });
      else if (!sameState(stateOf(prev), stateOf(r))) changes.changed.push({ id: r.id, before: stateOf(prev), after: stateOf(r) });
    }
    return { result, changes };
  }

  /** Conflicts (German) that prevent reverting `changes`: relations changed or removed since the edit. */
  relationChangeConflicts(changes: RelationChangeSet | undefined): string[] {
    if (!changes) return [];
    const conflicts: string[] = [];
    const current = (id: string) => this.db.select().from(relations).where(eq(relations.id, id)).get();
    for (const c of changes.created) {
      const r = current(c.id);
      if (r && r.status !== c.status) conflicts.push('Eine bei der Bearbeitung angelegte Verknüpfung wurde seitdem bestätigt oder abgelehnt.');
    }
    for (const c of changes.changed) {
      const r = current(c.id);
      if (!r) conflicts.push('Eine bei der Bearbeitung geänderte Verknüpfung wurde seitdem gelöscht.');
      else if (r.status !== c.after.status) conflicts.push('Eine bei der Bearbeitung geänderte Verknüpfung wurde seitdem bestätigt oder abgelehnt.');
    }
    return [...new Set(conflicts)];
  }

  /** Restores the relations recorded by `trackRelationChanges` (call inside the undo transaction). */
  revertRelationChanges(changes: RelationChangeSet | undefined): void {
    if (!changes || (changes.created.length === 0 && changes.changed.length === 0)) return;
    const now = nowIso();
    for (const c of changes.created) this.db.delete(relations).where(eq(relations.id, c.id)).run();
    for (const c of changes.changed) {
      this.db
        .update(relations)
        .set({ status: c.before.status, confidence: c.before.confidence, sourceIds: c.before.sourceIds, updatedAt: now })
        .where(eq(relations.id, c.id))
        .run();
    }
    this.ctx.events.changed('knowledge');
  }

  private relationRowsOf(entityId: string): RelationRow[] {
    return this.db
      .select()
      .from(relations)
      .where(or(eq(relations.sourceEntityId, entityId), eq(relations.targetEntityId, entityId)))
      .all();
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

  /** Führt `source` in `target` zusammen (Beziehungen und Fachobjekt-Referenzen werden umgehängt). */
  mergeEntities(sourceId: string, targetId: string): { relationsMoved: number } {
    const source = this.getEntity(sourceId);
    const target = this.getEntity(targetId);
    if (!source || !target) throw new AppError('validation_error', 'Zusammenführung: Eintrag nicht gefunden.');
    if (source.type !== target.type) throw new AppError('validation_error', 'Nur gleichartige Einträge können zusammengeführt werden.');
    let moved = 0;
    this.ctx.database.transaction(() => {
      for (const r of this.relationsOf(sourceId)) {
        const s = r.sourceEntityId === sourceId ? targetId : r.sourceEntityId;
        const t = r.targetEntityId === sourceId ? targetId : r.targetEntityId;
        this.db.delete(relations).where(eq(relations.id, r.id)).run();
        if (s !== t) {
          this.link(s, t, r.relationType, { confidence: r.confidence, status: r.status, sourceIds: r.sourceIds });
          moved += 1;
        }
      }
      for (const col of ['topicId', 'projectId'] as const) {
        if (source.type !== (col === 'topicId' ? 'topic' : 'project')) continue;
        this.db
          .update(documents)
          .set({ [col]: targetId })
          .where(eq(documents[col], sourceId))
          .run();
        this.db
          .update(decisions)
          .set({ [col]: targetId })
          .where(eq(decisions[col], sourceId))
          .run();
        this.db
          .update(openItems)
          .set({ [col]: targetId })
          .where(eq(openItems[col], sourceId))
          .run();
      }
      this.db.delete(entities).where(eq(entities.id, sourceId)).run();
    });
    this.ctx.events.changed('knowledge', 'documents', 'decisions', 'openItems');
    return { relationsMoved: moved };
  }
}
