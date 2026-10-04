import type { EntityType, GraphRelation, RelationMethod, RelationStatus, RelationType } from '@archivist/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { currentRun } from '../../agent/scope';
import { entities, relations } from '../../db/schema';
import { AppError } from '../../util/errors';
import { newId, nowIso } from '../../util/ids';
import { ACTIVE_STATUSES, findRelationRow, mapRelation, otherEndOf, relationRow, relationRowsOf, type RelationKey, type RelationRow } from './rows';

export interface LinkOptions {
  confidence?: number;
  status?: RelationStatus;
  sourceIds?: string[];
  resolvedByUser?: boolean;
  origin?: 'system' | 'user' | 'agent';
  /** How it came about (#270); derived when missing: a relation to a topic, project, person … mirrors a field. */
  method?: RelationMethod;
  /** Why it was proposed: passage, message, date and person … (#270) */
  evidence?: string | null;
}

/** Result of `link`: the relation and whether this call created it (`false`: it existed and was at most updated). */
export type LinkResult = GraphRelation & { created: boolean };

/** Mutable state of a relation that field sync may change (restored on undo). */
export interface RelationState {
  status: RelationStatus;
  confidence: number;
  sourceIds: string[];
}

/** Relation changes of one edit: relations it created (deleted again on undo) and relations whose state it changed. */
export interface RelationChangeSet {
  created: Array<{ id: string; status: RelationStatus }>;
  changed: Array<{ id: string; before: RelationState; after: RelationState }>;
}

/** A relation a wiki link was written over (#285), as it was before; undoing the note edit restores it. */
export type AdoptedRelation = Pick<GraphRelation, 'id' | 'status' | 'confidence' | 'resolvedByUser' | 'origin' | 'runId' | 'method' | 'evidence' | 'updatedAt'>;

export interface SystemUnlink {
  entityId: string;
  relationType: RelationType;
  keepIds: readonly string[];
  /** `out`: `entityId` is the relation source, `in`: its target. */
  direction?: 'out' | 'in';
  /** Restricts the other end (e.g. only topics, not tags). */
  otherType?: EntityType;
}

/** Named nodes a field of an entry points to (topic, project, persons, tags, folder, case): relations to them mirror fields. */
const HUB_TYPES = new Set<string>(['topic', 'project', 'person', 'tag', 'category', 'case']);
/** Relation types the analysis of a document or a capture proposes between two entries. */
const ANALYSIS_TYPES = new Set<string>(['supports', 'results_from', 'supersedes', 'contradicts', 'duplicate_of']);
const EVIDENCE_MAX = 300;

const clipEvidence = (evidence: string | null | undefined): string | null => {
  const text = evidence?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > EVIDENCE_MAX ? `${text.slice(0, EVIDENCE_MAX - 1)}…` : text;
};

const stateOf = (row: RelationRow): RelationState => ({ status: row.status as RelationStatus, confidence: row.confidence, sourceIds: row.sourceIds });
const sameState = (a: RelationState, b: RelationState) =>
  a.status === b.status && a.confidence === b.confidence && JSON.stringify(a.sourceIds) === JSON.stringify(b.sourceIds);

/** Status of an existing relation linked anew: user decisions are kept; an outdated relation becomes current again. */
function relinkedStatus(existing: RelationRow, requested: RelationStatus | undefined): string {
  if (existing.resolvedByUser) return existing.status;
  if (existing.status === 'confirmed') return 'confirmed';
  if (existing.status === 'outdated') return requested ?? 'proposed';
  return requested ?? existing.status;
}

interface ResolvedLink {
  options: LinkOptions;
  method: RelationMethod | null;
  evidence: string | null;
}

/** Relations between entities: creating, deciding, querying and tracking them for undo. */
export class GraphRelations {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Creates a relation; rejected ones are not revived, confirmed ones never downgraded. */
  link(key: RelationKey, options: LinkOptions): LinkResult | null {
    if (key.sourceId === key.targetId) return null;
    const method = options.method ?? this.inferMethod(key);
    const resolved: ResolvedLink = { options, method, evidence: clipEvidence(options.evidence) };
    const rejected = this.blockingRejection(key, resolved);
    if (rejected) return { ...rejected, created: false };
    const existing = findRelationRow(this.db, key);
    return existing ? this.relink(existing, resolved) : this.insert(key, resolved);
  }

  /** A pair the user rejected is never proposed again – by no method, in either direction, whatever the type (#270). */
  private blockingRejection(key: RelationKey, link: ResolvedLink): GraphRelation | undefined {
    const proposal = (link.options.status ?? 'proposed') === 'proposed' && !link.options.resolvedByUser;
    if (!proposal || key.relationType === 'duplicate_of' || link.method === 'field') return undefined;
    return this.rejectedBetween({ a: key.sourceId, b: key.targetId });
  }

  private relink(existing: RelationRow, link: ResolvedLink): LinkResult {
    if (existing.status === 'rejected') return { ...mapRelation(existing), created: false };
    const status = relinkedStatus(existing, link.options.status);
    const sourceIds = [...new Set([...existing.sourceIds, ...(link.options.sourceIds ?? [])])];
    const confidence = Math.max(existing.confidence, link.options.confidence ?? 0);
    // origin and evidence of the first finding are kept; a relation without them takes them over
    const kept = { method: existing.method ?? link.method, evidence: existing.evidence ?? link.evidence };
    // nothing changes: updatedAt stays, it marks the user's decision for its undo
    if (
      sameState(stateOf(existing), { status: status as RelationStatus, confidence, sourceIds }) &&
      kept.method === existing.method &&
      kept.evidence === existing.evidence
    )
      return { ...mapRelation(existing), created: false };
    const updatedAt = nowIso();
    this.db
      .update(relations)
      .set({ status, sourceIds, confidence, ...kept, updatedAt })
      .where(eq(relations.id, existing.id))
      .run();
    return { ...mapRelation({ ...existing, status, sourceIds, confidence, ...kept, updatedAt }), created: false };
  }

  private insert(key: RelationKey, link: ResolvedLink): LinkResult {
    const { options } = link;
    const now = nowIso();
    const run = currentRun();
    const row: RelationRow = {
      id: newId(),
      sourceEntityId: key.sourceId,
      targetEntityId: key.targetId,
      relationType: key.relationType,
      confidence: options.confidence ?? 0.5,
      sourceIds: options.sourceIds ?? [],
      status: options.status ?? 'proposed',
      resolvedByUser: options.resolvedByUser ?? false,
      // inside an agent run the relation is the agent's (origin and run id, #270/#299)
      origin: run ? 'agent' : (options.origin ?? (options.resolvedByUser ? 'user' : 'system')),
      runId: run?.runId ?? null,
      method: link.method,
      evidence: link.evidence,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(relations).values(row).run();
    this.ctx.events.changed('knowledge');
    return { ...mapRelation(row), created: true };
  }

  /** `field` for a relation to a named node (topic, project, person …), `analysis` for the fixed record relations, else null. */
  private inferMethod(key: RelationKey): RelationMethod | null {
    const types = this.db
      .select({ type: entities.type })
      .from(entities)
      .where(inArray(entities.id, [key.sourceId, key.targetId]))
      .all()
      .map((row) => row.type);
    if (types.some((type) => HUB_TYPES.has(type))) return 'field';
    return ANALYSIS_TYPES.has(key.relationType) ? 'analysis' : null;
  }

  get(id: string): GraphRelation | undefined {
    const row = relationRow(this.db, id);
    return row ? mapRelation(row) : undefined;
  }

  delete(id: string): void {
    this.db.delete(relations).where(eq(relations.id, id)).run();
    this.ctx.events.changed('knowledge');
  }

  setStatus(id: string, change: { status: RelationStatus; by: 'user' | 'system' }): GraphRelation {
    const relation = this.get(id);
    if (!relation) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    this.db
      .update(relations)
      .set({ status: change.status, updatedAt: nowIso(), ...(change.by === 'user' ? { resolvedByUser: true } : {}) })
      .where(eq(relations.id, id))
      .run();
    this.ctx.events.changed('knowledge');
    return { ...relation, status: change.status };
  }

  /** Takes a relation over as a confirmed wiki link with the link text as evidence (#285); inside an agent run it is the agent's. */
  adoptAsWikiLink(id: string, evidence: string): void {
    const run = currentRun();
    const origin = run ? 'agent' : 'user';
    this.db
      .update(relations)
      .set({ status: 'confirmed', confidence: 1, resolvedByUser: true, origin, runId: run?.runId ?? null, method: 'wikilink', evidence, updatedAt: nowIso() })
      .where(eq(relations.id, id))
      .run();
    this.ctx.events.changed('knowledge');
  }

  /** Restores relations {@link adoptAsWikiLink} took over, unless they are no wiki link any more. */
  restoreAdopted(adopted: readonly AdoptedRelation[]): void {
    for (const { id, status, confidence, resolvedByUser, origin, runId, method, evidence, updatedAt } of adopted)
      this.db
        .update(relations)
        .set({
          status,
          confidence,
          resolvedByUser: resolvedByUser ?? false,
          origin: origin ?? null,
          runId: runId ?? null,
          method: method ?? null,
          evidence: evidence ?? null,
          updatedAt,
        })
        .where(and(eq(relations.id, id), eq(relations.method, 'wikilink')))
        .run();
    if (adopted.length) this.ctx.events.changed('knowledge');
  }

  of(entityId: string, filter: { statuses?: RelationStatus[]; types?: RelationType[] }): GraphRelation[] {
    return relationRowsOf(this.db, entityId)
      .map(mapRelation)
      .filter((relation) => (!filter.statuses || filter.statuses.includes(relation.status)) && (!filter.types || filter.types.includes(relation.relationType)));
  }

  /** A rejected relation between the two (either direction, also via records discarded as their duplicates, #270). */
  rejectedBetween(pair: { a: string; b: string; includeDuplicateOf?: boolean }): GraphRelation | undefined {
    const as = this.withDuplicates(pair.a);
    const bs = this.withDuplicates(pair.b);
    const row = this.db
      .select()
      .from(relations)
      .where(
        and(
          or(
            and(inArray(relations.sourceEntityId, as), inArray(relations.targetEntityId, bs)),
            and(inArray(relations.sourceEntityId, bs), inArray(relations.targetEntityId, as)),
          ),
          eq(relations.status, 'rejected'),
          pair.includeDuplicateOf ? undefined : sql`${relations.relationType} <> 'duplicate_of'`,
        ),
      )
      .get();
    return row ? mapRelation(row) : undefined;
  }

  private withDuplicates(id: string): string[] {
    const duplicates = this.db.select({ id: entities.id }).from(entities).where(eq(entities.duplicateOfId, id)).all();
    return [id, ...duplicates.map((row) => row.id)];
  }

  /** Marks the system's current relations of a field as outdated, except those to `keepIds`; returns their ids. */
  unlinkSystemRelations(unlink: SystemUnlink): string[] {
    const outgoing = (unlink.direction ?? 'out') === 'out';
    const otherOf = (row: RelationRow) => (outgoing ? row.targetEntityId : row.sourceEntityId);
    const rows = this.db
      .select()
      .from(relations)
      .where(
        and(
          eq(outgoing ? relations.sourceEntityId : relations.targetEntityId, unlink.entityId),
          eq(relations.relationType, unlink.relationType),
          inArray(relations.status, ACTIVE_STATUSES),
          eq(relations.resolvedByUser, false),
        ),
      )
      .all()
      .filter((row) => !unlink.keepIds.includes(otherOf(row)));
    const typeOf = this.typesOf(unlink.otherType ? rows.map(otherOf) : []);
    const stale = rows.filter((row) => !unlink.otherType || typeOf.get(otherOf(row)) === unlink.otherType);
    if (stale.length === 0) return [];
    const ids = stale.map((row) => row.id);
    this.db.update(relations).set({ status: 'outdated', updatedAt: nowIso() }).where(inArray(relations.id, ids)).run();
    this.ctx.events.changed('knowledge');
    return ids;
  }

  private typesOf(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.db.select({ id: entities.id, type: entities.type }).from(entities).where(inArray(entities.id, ids)).all();
    return new Map(rows.map((row) => [row.id, row.type]));
  }

  /** Runs `change` and records how the relations touching `entityId` changed, for {@link revertChanges}. */
  trackChanges<T>(entityId: string, change: () => T): { result: T; changes: RelationChangeSet } {
    const before = new Map(relationRowsOf(this.db, entityId).map((row) => [row.id, row]));
    const result = change();
    const changes: RelationChangeSet = { created: [], changed: [] };
    for (const row of relationRowsOf(this.db, entityId)) {
      const previous = before.get(row.id);
      if (!previous) changes.created.push({ id: row.id, status: row.status as RelationStatus });
      else if (!sameState(stateOf(previous), stateOf(row))) changes.changed.push({ id: row.id, before: stateOf(previous), after: stateOf(row) });
    }
    return { result, changes };
  }

  /** Conflicts (German) that prevent reverting `changes`: relations changed or removed since the edit. */
  changeConflicts(changes: RelationChangeSet | undefined): string[] {
    if (!changes) return [];
    const conflicts: string[] = [];
    for (const created of changes.created) {
      const row = relationRow(this.db, created.id);
      if (row && row.status !== created.status) conflicts.push('Eine bei der Bearbeitung angelegte Verknüpfung wurde seitdem bestätigt oder abgelehnt.');
    }
    for (const changed of changes.changed) {
      const row = relationRow(this.db, changed.id);
      if (!row) conflicts.push('Eine bei der Bearbeitung geänderte Verknüpfung wurde seitdem gelöscht.');
      else if (row.status !== changed.after.status) conflicts.push('Eine bei der Bearbeitung geänderte Verknüpfung wurde seitdem bestätigt oder abgelehnt.');
    }
    return [...new Set(conflicts)];
  }

  /** Restores the relations recorded by {@link trackChanges} (call inside the undo transaction). */
  revertChanges(changes: RelationChangeSet | undefined): void {
    if (!changes || (changes.created.length === 0 && changes.changed.length === 0)) return;
    const now = nowIso();
    for (const created of changes.created) this.db.delete(relations).where(eq(relations.id, created.id)).run();
    for (const changed of changes.changed) {
      const { status, confidence, sourceIds } = changed.before;
      this.db.update(relations).set({ status, confidence, sourceIds, updatedAt: now }).where(eq(relations.id, changed.id)).run();
    }
    this.ctx.events.changed('knowledge');
  }

  /** The other ends of the entity's current relations. */
  activeNeighborIds(entityId: string, relationTypes?: RelationType[]): string[] {
    const current = this.of(entityId, { statuses: ACTIVE_STATUSES, types: relationTypes });
    return [...new Set(current.map((relation) => otherEndOf(relation, entityId)))];
  }
}
