import { RELATION_METHOD_LABELS, RELATION_PROVENANCE_LABELS, relationProvenance } from '@archivist/shared';
import type { EntityDetail, EntityType, GraphEntity, GraphRelation, RelationMethod, RelationStatus, RelationType } from '@archivist/shared';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { currentRun } from '../agent/scope';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { decisions, documents, entities, events, openItems, relations } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { personNameKey } from '../util/person-names';
import { normalizeName } from '../util/text';
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
  /** New name of the target (e.g. the cleanest spelling of a person); its former name becomes an alias. */
  targetName?: string;
  /** Roles added to the target in addition to those of the sources (e.g. parsed from „Monika Lor-Zade (Chefin)“). */
  addRoles?: string[];
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
  events: {
    table: events,
    the: 'Das Ereignis',
    a: 'Ein Ereignis',
    cols: ['topicId', 'projectId', 'participants', 'updatedAt'],
    lists: { person: 'participants' },
  },
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

/**
 * Explicit user decisions win over proposals when two relations are combined: a relation the user
 * confirmed or rejected (`resolvedByUser`) keeps its status over a system one, and the flag is kept.
 */
const STATUS_RANK: Record<string, number> = { confirmed: 3, rejected: 2, proposed: 1, outdated: 0 };
function combineRelations(a: RelationRow, b: RelationRow): Pick<RelationRow, 'status' | 'confidence' | 'sourceIds' | 'resolvedByUser'> {
  const rank = (r: RelationRow) => (r.resolvedByUser ? 10 : 0) + (STATUS_RANK[r.status] ?? 0);
  return {
    status: rank(b) > rank(a) ? b.status : a.status,
    resolvedByUser: a.resolvedByUser || b.resolvedByUser,
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

function mergeRoles(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map(personNameKey));
  const out = [...existing];
  for (const r of added) {
    const role = r.trim().replace(/\s+/g, ' ');
    const key = personNameKey(role);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(role);
  }
  return out;
}

const mapEntity = (r: EntityRow): GraphEntity => ({
  id: r.id,
  type: r.type as EntityType,
  name: r.name,
  description: r.description,
  aliases: r.aliases,
  roles: r.roles,
  duplicateOfId: r.duplicateOfId,
  isSelf: r.isSelf,
  status: r.status,
  ...(r.unconfirmed ? { unconfirmed: true } : {}),
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
  origin: r.origin,
  runId: r.runId,
  method: (r.method as RelationMethod | null) ?? null,
  evidence: r.evidence,
  resolvedByUser: r.resolvedByUser,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** A node with its relations, captured before {@link KnowledgeGraphService.removeNode} so an undo can restore both. */
export interface NodeSnapshot {
  node: EntityRow;
  relations: RelationRow[];
}

/** Result of `link`: the relation and whether this call created it (`false`: it existed and was at most updated). */
export type LinkResult = GraphRelation & { created: boolean };

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

/** Named nodes a field of an entry points to (topic, project, persons, tags, folder, case): relations to them mirror fields. */
export const HUB_TYPES = new Set<string>(['topic', 'project', 'person', 'tag', 'category', 'case']);
/** Relation types the analysis of a document or a capture proposes between two entries. */
const ANALYSIS_TYPES = new Set<string>(['supports', 'results_from', 'supersedes', 'contradicts', 'duplicate_of']);
/** Maximum length of the stored evidence of a relation. */
const EVIDENCE_MAX = 300;
const clipEvidence = (e: string | null | undefined): string | null => {
  const t = e?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > EVIDENCE_MAX ? `${t.slice(0, EVIDENCE_MAX - 1)}…` : t;
};

/** What can be a subtopic of what (#282). */
const SUBJECT_TYPES = new Set<EntityType>(['topic', 'project']);

/** Statuses that count as a current, visible assignment. */
const ACTIVE_STATUSES: RelationStatus[] = ['proposed', 'confirmed'];

/** Undo of a link or unlink made through {@link KnowledgeGraphService.linkEntries} / `unlinkEntries` (#277). */
const LINK_UNDO_TYPE = 'relation.link';
const CASE_UNDO_TYPE = 'case.status';
/** Undo of several links made at once – a bulk assignment (#286, #291). */
export const LINK_MANY_UNDO_TYPE = 'relation.linkMany';
export interface LinkManyUndoData {
  items: LinkUndoData[];
}
/** Undo of several proposals decided at once (#280). */
const DECIDE_MANY_UNDO_TYPE = 'relation.decideMany';
interface DecideManyUndoData {
  before: Array<Pick<RelationRow, 'id' | 'status' | 'resolvedByUser' | 'updatedAt'>>;
  /** updatedAt of each relation right after the decision; a later change blocks the undo. */
  after: Record<string, string>;
}
export interface LinkUndoData {
  /** The relation as it was before (null: the call created it). */
  before: RelationRow | null;
  /** The relation as the call left it (null: the call removed it). */
  after: RelationRow | null;
}

/** An entry connected to another one, with the path and the reason (#276, #289). */
export interface RelatedEntry {
  entity: GraphEntity;
  depth: number;
  relation: GraphRelation;
  /** Plain-language reason: relation type, status, origin and evidence count. */
  reason: string;
  /** Entry in between for depth 2. */
  via: GraphEntity | null;
}

const RELATION_LABEL: Record<RelationType, string> = {
  belongs_to: 'gehört zu',
  relates_to: 'bezieht sich auf',
  supports: 'stützt',
  contradicts: 'widerspricht',
  participated_in: 'beteiligt an',
  responsible_for: 'verantwortlich für',
  concerns: 'betrifft',
  affects: 'wirkt sich aus auf',
  supersedes: 'ersetzt',
  blocks: 'blockiert',
  results_from: 'folgt aus',
  produced: 'hat erzeugt',
  duplicate_of: 'Duplikat von',
  related_to: 'verwandt mit',
  subtopic_of: 'Unterthema von',
};

/** Plain-language reason of a relation: type, status, who stands behind it, how it came about and its evidence (#270, #276). */
export function relationReason(r: GraphRelation): string {
  const status = r.status === 'confirmed' ? 'bestätigt' : r.status === 'proposed' ? 'vorgeschlagen' : r.status === 'outdated' ? 'veraltet' : 'abgelehnt';
  const who = r.origin === 'agent' && relationProvenance(r) === 'auto' ? 'vom Agenten' : RELATION_PROVENANCE_LABELS[relationProvenance(r)];
  const how = r.method && r.method !== 'manual' ? `, ${RELATION_METHOD_LABELS[r.method]}` : '';
  const evidence = r.evidence ? ` – „${r.evidence}“` : '';
  return `${RELATION_LABEL[r.relationType] ?? r.relationType} (${status}, ${who}${how})${evidence}`;
}

/** Knowledge graph over entity and relation tables in SQLite. */
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
    undo.register(CASE_UNDO_TYPE, {
      check: async (data) => {
        const d = data as { id: string; afterUpdatedAt: string };
        const row = this.db.select().from(entities).where(eq(entities.id, d.id)).get();
        return !row ? ['Der Vorgang existiert nicht mehr.'] : row.updatedAt !== d.afterUpdatedAt ? ['Der Vorgang wurde seither verändert.'] : [];
      },
      run: async (data) => {
        const d = data as { id: string; before: string | null; beforeUpdatedAt: string };
        this.db.update(entities).set({ status: d.before, updatedAt: d.beforeUpdatedAt }).where(eq(entities.id, d.id)).run();
        this.ctx.events.changed('knowledge');
        return 'Status des Vorgangs zurückgesetzt.';
      },
    });
    undo.register(DECIDE_MANY_UNDO_TYPE, {
      check: async (data) => {
        const d = data as DecideManyUndoData;
        const ids = Object.keys(d.after);
        const now = new Map((ids.length ? this.db.select().from(relations).where(inArray(relations.id, ids)).all() : []).map((r) => [r.id, r.updatedAt]));
        const changed = ids.filter((id) => now.get(id) !== d.after[id]).length;
        return changed ? [`${changed} der Verknüpfungen wurde${changed === 1 ? '' : 'n'} seither verändert oder entfernt.`] : [];
      },
      run: async (data) => {
        const d = data as DecideManyUndoData;
        this.ctx.database.transaction(() => {
          for (const b of d.before)
            this.db.update(relations).set({ status: b.status, resolvedByUser: b.resolvedByUser, updatedAt: b.updatedAt }).where(eq(relations.id, b.id)).run();
        });
        this.ctx.events.changed('knowledge');
        return `${d.before.length} Entscheidung${d.before.length === 1 ? '' : 'en'} über Verknüpfungen zurückgenommen.`;
      },
    });
    undo.register(LINK_MANY_UNDO_TYPE, {
      check: async (data) => {
        const issues = (data as LinkManyUndoData).items.flatMap((i) => this.linkUndoConflicts(i));
        return issues.length ? [`${issues.length} der Verknüpfungen wurde${issues.length === 1 ? '' : 'n'} seither verändert oder entfernt.`] : [];
      },
      run: async (data) => {
        const items = (data as LinkManyUndoData).items;
        this.ctx.database.transaction(() => {
          for (const i of items) this.linkUndoRun(i);
        });
        return `${items.length} Zuordnung${items.length === 1 ? '' : 'en'} zurückgenommen.`;
      },
    });
    undo.register(LINK_UNDO_TYPE, {
      check: async (data) => this.linkUndoConflicts(data as LinkUndoData),
      run: async (data) => this.linkUndoRun(data as LinkUndoData),
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  getEntity(id: string): GraphEntity | undefined {
    const r = this.db.select().from(entities).where(eq(entities.id, id)).get();
    return r ? mapEntity(r) : undefined;
  }

  /** Finds or creates a named entity (topic, project, person …) by its normalized name. */
  /**
   * The entity of this type and name, created if missing. `fromDocument`: the name was taken from a document's
   * analysis – a new entity is marked unconfirmed (kept out of LLM prompts, #199). Any other use of the name
   * (the user typed it, a decision or open item uses it) confirms it.
   */
  ensureEntity(type: EntityType, name: string, description?: string | null, opts: { fromDocument?: boolean } = {}): GraphEntity {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw new AppError('validation_error', 'Der Name darf nicht leer sein.');
    const norm = normalizeName(clean);
    const existing = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), eq(entities.normalizedName, norm)))
      .get();
    if (existing) {
      if (existing.unconfirmed && !opts.fromDocument) return this.confirmEntity(existing.id);
      return mapEntity(existing);
    }
    const now = nowIso();
    const row: EntityRow = {
      id: newId(),
      type,
      name: clean,
      normalizedName: norm,
      description: description ?? null,
      aliases: [],
      roles: [],
      duplicateOfId: null,
      isSelf: false,
      unconfirmed: Boolean(opts.fromDocument) && (type === 'topic' || type === 'project'),
      createdAt: now,
      updatedAt: now,
      status: type === 'case' ? 'open' : null,
    };
    this.db.insert(entities).values(row).run();
    this.ctx.events.changed('knowledge');
    return mapEntity(row);
  }

  /** The user accepts a topic/project taken from a document: from now on it is listed in LLM prompts. */
  confirmEntity(id: string): GraphEntity {
    const row = this.db.select().from(entities).where(eq(entities.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    if (!row.unconfirmed) return mapEntity(row);
    const updatedAt = nowIso();
    this.db.update(entities).set({ unconfirmed: false, updatedAt }).where(eq(entities.id, id)).run();
    this.ctx.events.changed('knowledge');
    return mapEntity({ ...row, unconfirmed: false, updatedAt });
  }

  findByName(type: EntityType, name: string): GraphEntity | undefined {
    const r = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), eq(entities.normalizedName, normalizeName(name))))
      .get();
    return r ? mapEntity(r) : undefined;
  }

  /** Registers documents/decisions/open items as nodes with their own (given) id. */
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

  /** Captures a node and its relations (for the undo of a later `removeNode`); `null` if the node does not exist. */
  snapshotNode(id: string): NodeSnapshot | null {
    const node = this.entityRow(id);
    return node ? { node, relations: this.relationRowsOf(id) } : null;
  }

  /**
   * Restores a node captured by `snapshotNode` with its original ids. Relations whose other end no longer
   * exists are skipped. Returns the number of skipped relations.
   */
  restoreNode(snapshot: NodeSnapshot): number {
    this.db.insert(entities).values(snapshot.node).onConflictDoNothing().run();
    let skipped = 0;
    for (const r of snapshot.relations) {
      const other = r.sourceEntityId === snapshot.node.id ? r.targetEntityId : r.sourceEntityId;
      if (!this.entityRow(other)) {
        skipped++;
        continue;
      }
      this.db.insert(relations).values(r).onConflictDoNothing().run();
    }
    this.ctx.events.changed('knowledge');
    return skipped;
  }

  /**
   * Creates a relation. Already rejected relations are not revived,
   * confirmed ones are never downgraded.
   * `created` tells whether the relation was newly created (`true`) or already existed and was at most updated
   * (`false`). Undo must only delete created relations; use `trackRelationChanges` to also restore updated ones.
   */
  link(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    opts: {
      confidence?: number;
      status?: RelationStatus;
      sourceIds?: string[];
      resolvedByUser?: boolean;
      origin?: 'system' | 'user' | 'agent';
      /** How it came about (#270); derived when missing: a relation to a topic, project, person … mirrors a field. */
      method?: RelationMethod;
      /** Why it was proposed: passage, message, date and person … (#270) */
      evidence?: string | null;
    } = {},
  ): LinkResult | null {
    if (sourceId === targetId) return null;
    const status0 = opts.status ?? 'proposed';
    const method = opts.method ?? this.inferMethod(sourceId, targetId, relationType);
    const evidence = clipEvidence(opts.evidence);
    // a pair of entries the user rejected is never proposed again – by no method, in either direction, whatever the type (#270)
    if (status0 === 'proposed' && !opts.resolvedByUser && relationType !== 'duplicate_of' && method !== 'field') {
      const rejected = this.rejectedBetween(sourceId, targetId);
      if (rejected) return { ...rejected, created: false };
    }
    const existing = this.db
      .select()
      .from(relations)
      .where(and(eq(relations.sourceEntityId, sourceId), eq(relations.targetEntityId, targetId), eq(relations.relationType, relationType)))
      .get();
    const now = nowIso();
    if (existing) {
      if (existing.status === 'rejected') return { ...mapRelation(existing), created: false };
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
      // origin and evidence of the first finding are kept; a relation without them takes them over
      const keep = { method: existing.method ?? method, evidence: existing.evidence ?? evidence };
      this.db
        .update(relations)
        .set({ status, sourceIds, confidence, ...keep, updatedAt: now })
        .where(eq(relations.id, existing.id))
        .run();
      return { ...mapRelation({ ...existing, status, sourceIds, confidence, ...keep, updatedAt: now }), created: false };
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
      // inside an agent run the relation is the agent's (origin and run id, #270/#299)
      origin: currentRun() ? 'agent' : (opts.origin ?? (opts.resolvedByUser ? 'user' : 'system')),
      runId: currentRun()?.runId ?? null,
      method,
      evidence,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(relations).values(row).run();
    this.ctx.events.changed('knowledge');
    return { ...mapRelation(row), created: true };
  }

  /** `field` for a relation to a named node (topic, project, person …), `analysis` for the fixed record relations, else null. */
  private inferMethod(sourceId: string, targetId: string, relationType: RelationType): RelationMethod | null {
    const types = this.db
      .select({ type: entities.type })
      .from(entities)
      .where(inArray(entities.id, [sourceId, targetId]))
      .all()
      .map((r) => r.type);
    if (types.some((t) => HUB_TYPES.has(t))) return 'field';
    return ANALYSIS_TYPES.has(relationType) ? 'analysis' : null;
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

  /** Entities connected to `entityId` via active (not rejected) relations. */
  neighbors(entityId: string, opts: { types?: EntityType[]; relationTypes?: RelationType[] } = {}): GraphEntity[] {
    const rels = this.relationsOf(entityId, { statuses: ACTIVE_STATUSES, types: opts.relationTypes });
    const ids = [...new Set(rels.map((r) => (r.sourceEntityId === entityId ? r.targetEntityId : r.sourceEntityId)))];
    if (ids.length === 0) return [];
    const found = this.db.select().from(entities).where(inArray(entities.id, ids)).all().map(mapEntity);
    return opts.types ? found.filter((e) => opts.types!.includes(e.type)) : found;
  }

  /** `confirmedOnly`: without topics/projects taken from documents that the user has not confirmed (for LLM prompts). */
  listEntities(opts: { type?: EntityType; query?: string; limit?: number; confirmedOnly?: boolean } = {}): Array<GraphEntity & { relationCount: number }> {
    const conds = [];
    if (opts.type) conds.push(eq(entities.type, opts.type));
    if (opts.confirmedOnly) conds.push(eq(entities.unconfirmed, false));
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

  /**
   * Neighbours of an entry up to `depth` (1 or 2) over current relations, each with its reason – the same query the
   * knowledge page uses for „Verwandte Einträge“ (#276) and the agent for research across the graph (#289).
   */
  related(id: string, opts: { depth?: number; limit?: number; types?: EntityType[] } = {}): RelatedEntry[] {
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 2);
    const out = new Map<string, RelatedEntry>();
    const visit = (from: string, level: number, via: GraphEntity | null) => {
      for (const r of this.relationsOf(from, { statuses: ACTIVE_STATUSES })) {
        const otherId = r.sourceEntityId === from ? r.targetEntityId : r.sourceEntityId;
        if (otherId === id || out.has(otherId)) continue;
        const other = this.getEntity(otherId);
        if (!other || other.duplicateOfId) continue;
        out.set(otherId, { entity: other, depth: level, relation: r, reason: relationReason(r), via });
      }
    };
    visit(id, 1, null);
    if (depth === 2)
      for (const first of [...out.values()]) {
        // hubs (topics with hundreds of documents) are not expanded – they say little about a single entry
        if (first.entity.type === 'category' || first.entity.type === 'tag') continue;
        visit(first.entity.id, 2, first.entity);
      }
    return [...out.values()]
      .filter((e) => !opts.types || opts.types.includes(e.entity.type))
      .toSorted(
        (a, b) =>
          a.depth - b.depth ||
          Number(b.relation.status === 'confirmed') - Number(a.relation.status === 'confirmed') ||
          b.relation.confidence - a.relation.confidence,
      )
      .slice(0, opts.limit ?? 100);
  }

  /**
   * A relation between the two entries (either direction, any type) that the user rejected – such pairs are never proposed
   * again (#270). Also counts for records discarded as duplicates of one of the two, so a rejection survives merging them.
   * A rejected „Duplikat“ only means „different“, not „unrelated“, and does not count unless `includeDuplicateOf`.
   */
  rejectedBetween(a: string, b: string, opts: { includeDuplicateOf?: boolean } = {}): GraphRelation | undefined {
    const side = (id: string) => [
      id,
      ...this.db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.duplicateOfId, id))
        .all()
        .map((r) => r.id),
    ];
    const as = side(a);
    const bs = side(b);
    const r = this.db
      .select()
      .from(relations)
      .where(
        and(
          or(
            and(inArray(relations.sourceEntityId, as), inArray(relations.targetEntityId, bs)),
            and(inArray(relations.sourceEntityId, bs), inArray(relations.targetEntityId, as)),
          ),
          eq(relations.status, 'rejected'),
          opts.includeDuplicateOf ? undefined : sql`${relations.relationType} <> 'duplicate_of'`,
        ),
      )
      .get();
    return r ? mapRelation(r) : undefined;
  }

  /** Rejected pairs of an entry (the agent names them on request, #306). */
  rejectedPairsOf(id: string): Array<{ relation: GraphRelation; other: GraphEntity }> {
    return this.relationsOf(id, { statuses: ['rejected'] }).flatMap((r) => {
      const other = this.getEntity(r.sourceEntityId === id ? r.targetEntityId : r.sourceEntityId);
      return other ? [{ relation: r, other }] : [];
    });
  }

  /**
   * Links two entries (knowledge page and agent use the same function, #277). `confirmed`: the user asked for it (in the
   * agent: an explicit request in mode „Auto“); otherwise the link stays a proposal. Rejected pairs are refused.
   * Logged with undo.
   */
  linkEntries(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    opts: {
      status: 'confirmed' | 'proposed';
      trigger?: string;
      confidence?: number;
      origin?: 'user' | 'system';
      /** Default: `manual` for a link the user asked for, `agent` for a proposal of the agent (#270). */
      method?: RelationMethod;
      evidence?: string | null;
    },
  ): { relation: GraphRelation; created: boolean } {
    if (sourceId === targetId) throw new AppError('validation_error', 'Ein Eintrag kann nicht mit sich selbst verknüpft werden.');
    const a = this.getEntity(sourceId);
    const b = this.getEntity(targetId);
    if (!a || !b) throw new AppError('validation_error', 'Einer der Einträge existiert nicht.');
    if (relationType === 'subtopic_of') {
      if (!SUBJECT_TYPES.has(a.type) || !SUBJECT_TYPES.has(b.type))
        throw new AppError('validation_error', 'Nur Themen und Projekte können Unterthema eines anderen sein.');
      if (this.subtreeOf(sourceId).includes(targetId))
        throw new AppError('validation_error', `„${b.name}“ liegt bereits unter „${a.name}“ – das ergäbe einen Kreis.`);
    }
    if (opts.status === 'proposed' && this.rejectedBetween(sourceId, targetId))
      throw new AppError('validation_error', `Die Verknüpfung „${a.name}“ – „${b.name}“ wurde abgelehnt und wird nicht wieder vorgeschlagen.`);
    const before =
      this.db
        .select()
        .from(relations)
        .where(and(eq(relations.sourceEntityId, sourceId), eq(relations.targetEntityId, targetId), eq(relations.relationType, relationType)))
        .get() ?? null;
    const confirmed = opts.status === 'confirmed';
    if (before && confirmed && before.status !== 'confirmed') {
      this.db.update(relations).set({ status: 'confirmed', resolvedByUser: true, updatedAt: nowIso() }).where(eq(relations.id, before.id)).run();
    }
    const res =
      before && confirmed
        ? null
        : this.link(sourceId, targetId, relationType, {
            confidence: opts.confidence ?? (confirmed ? 1 : 0.6),
            status: opts.status,
            resolvedByUser: confirmed,
            // proposals of the fixed link methods are the system's, not the user's (#270)
            origin: opts.origin ?? 'user',
            method: opts.method ?? (confirmed ? 'manual' : currentRun() ? 'agent' : undefined),
            evidence: opts.evidence,
          });
    const after = this.db
      .select()
      .from(relations)
      .where(and(eq(relations.sourceEntityId, sourceId), eq(relations.targetEntityId, targetId), eq(relations.relationType, relationType)))
      .get()!;
    if (after.status === 'rejected' && !confirmed) throw new AppError('validation_error', 'Diese Verknüpfung wurde abgelehnt.');
    this.audit.log({
      action: 'relation.link',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed,
      entityIds: [after.id, sourceId, targetId],
      before: before ? { status: before.status } : null,
      after: { status: after.status, relationType },
      undo: { type: LINK_UNDO_TYPE, data: { before, after } satisfies LinkUndoData },
    });
    this.ctx.events.changed('knowledge');
    return { relation: mapRelation(after), created: res?.created ?? false };
  }

  /**
   * Links several entries with one target as the user's confirmed choice (bulk assignment to a case, topic or tag –
   * #286, #291): ONE audit entry, ONE undo step. Entries already linked that way are left as they are. Returns the
   * number of new or newly confirmed links.
   */
  linkMany(
    sourceIds: string[],
    targetId: string,
    relationType: RelationType,
    opts: { trigger?: string; action?: string; method?: RelationMethod } = {},
  ): number {
    const target = this.getEntity(targetId);
    if (!target) throw new AppError('validation_error', 'Das Ziel existiert nicht.');
    return this.changeLinks(
      { add: [...new Set(sourceIds)].map((sourceId) => ({ sourceId, targetId, relationType })) },
      { ...opts, summary: { target: target.name, relationType } },
    );
  }

  /**
   * Adds confirmed links (the user's choice) and removes others in ONE step – one audit entry, one undo (#287, #291).
   * Links that already are confirmed stay as they are. Returns the number of links added or removed.
   */
  changeLinks(
    change: { add?: Array<{ sourceId: string; targetId: string; relationType: RelationType }>; remove?: string[] },
    opts: { trigger?: string; action?: string; method?: RelationMethod; summary?: Record<string, unknown> } = {},
  ): number {
    const { items, entityIds } = this.applyLinkChanges(change, opts.method);
    if (!items.length) return 0;
    this.audit.log({
      action: opts.action ?? 'relation.linkMany',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [...entityIds],
      after: { ...opts.summary, count: items.length },
      undo: { type: LINK_MANY_UNDO_TYPE, data: { items } satisfies LinkManyUndoData },
    });
    this.ctx.events.changed('knowledge');
    return items.length;
  }

  /** {@link changeLinks} without its audit entry – for an action that logs several parts as one undo step (#291). */
  applyLinkChanges(
    change: { add?: Array<{ sourceId: string; targetId: string; relationType: RelationType }>; remove?: string[] },
    method?: RelationMethod,
  ): { items: LinkUndoData[]; entityIds: Set<string> } {
    const opts = { method };
    const items: LinkUndoData[] = [];
    const entityIds = new Set<string>();
    this.ctx.database.transaction(() => {
      for (const a of change.add ?? []) {
        if (a.sourceId === a.targetId || !this.getEntity(a.sourceId) || !this.getEntity(a.targetId)) continue;
        const find = () =>
          this.db
            .select()
            .from(relations)
            .where(and(eq(relations.sourceEntityId, a.sourceId), eq(relations.targetEntityId, a.targetId), eq(relations.relationType, a.relationType)))
            .get() ?? null;
        const before = find();
        if (before?.status === 'confirmed') continue;
        if (before) this.db.update(relations).set({ status: 'confirmed', resolvedByUser: true, updatedAt: nowIso() }).where(eq(relations.id, before.id)).run();
        else
          this.link(a.sourceId, a.targetId, a.relationType, {
            confidence: 1,
            status: 'confirmed',
            resolvedByUser: true,
            origin: 'user',
            method: opts.method ?? 'manual',
          });
        items.push({ before, after: find() });
        entityIds.add(a.sourceId).add(a.targetId);
      }
      for (const id of new Set(change.remove ?? [])) {
        const before = this.db.select().from(relations).where(eq(relations.id, id)).get();
        if (!before) continue;
        this.db.delete(relations).where(eq(relations.id, id)).run();
        items.push({ before, after: null });
        entityIds.add(before.sourceEntityId).add(before.targetEntityId);
      }
    });
    if (items.length) this.ctx.events.changed('knowledge');
    return { items, entityIds };
  }

  /** Removes a relation the user (or the agent on the user's request) no longer wants; logged with undo. */
  unlinkEntries(relationId: string, opts: { trigger?: string } = {}): GraphRelation {
    const before = this.db.select().from(relations).where(eq(relations.id, relationId)).get();
    if (!before) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    this.db.delete(relations).where(eq(relations.id, relationId)).run();
    this.audit.log({
      action: 'relation.unlink',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [relationId, before.sourceEntityId, before.targetEntityId],
      before: { status: before.status },
      after: null,
      undo: { type: LINK_UNDO_TYPE, data: { before, after: null } satisfies LinkUndoData },
    });
    this.ctx.events.changed('knowledge');
    return mapRelation(before);
  }

  /** Confirms or rejects a relation as the user's decision (also on the agent's side on request, #306); logged with undo. */
  decideRelation(relationId: string, status: 'confirmed' | 'rejected', opts: { trigger?: string } = {}): GraphRelation {
    const before = this.db.select().from(relations).where(eq(relations.id, relationId)).get();
    if (!before) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    // a more precise kind replaces the general „verwandt“ of the pair – both in one undo step (#284)
    if (status === 'confirmed' && before.method === 'refinement' && before.status === 'proposed') {
      this.decideRelations([relationId], 'confirmed', opts);
      return this.getRelation(relationId)!;
    }
    this.setRelationStatus(relationId, status);
    const after = this.db.select().from(relations).where(eq(relations.id, relationId)).get()!;
    this.audit.log({
      action: status === 'confirmed' ? 'relation.confirm' : 'relation.reject',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [relationId],
      before: { status: before.status },
      after: { status },
      undo: { type: LINK_UNDO_TYPE, data: { before, after } satisfies LinkUndoData },
    });
    return mapRelation(after);
  }

  /**
   * Confirms or rejects several proposals at once („Alle bestätigen“, #280): ONE audit entry, ONE undo step. Relations that
   * are no longer proposals are left as they are. Returns the number decided.
   */
  decideRelations(ids: string[], status: 'confirmed' | 'rejected', opts: { trigger?: string } = {}): number {
    const unique = [...new Set(ids)];
    if (!unique.length) return 0;
    const rows = this.db
      .select()
      .from(relations)
      .where(and(inArray(relations.id, unique), eq(relations.status, 'proposed')))
      .all();
    if (!rows.length) return 0;
    const updatedAt = nowIso();
    // a confirmed more precise kind (#284) makes the general „verwandt“ of its pair outdated – part of the same undo
    const general =
      status === 'confirmed'
        ? rows
            .filter((r) => r.method === 'refinement')
            .flatMap((r) =>
              this.db
                .select()
                .from(relations)
                .where(
                  and(
                    eq(relations.relationType, 'related_to'),
                    eq(relations.status, 'confirmed'),
                    or(
                      and(eq(relations.sourceEntityId, r.sourceEntityId), eq(relations.targetEntityId, r.targetEntityId)),
                      and(eq(relations.sourceEntityId, r.targetEntityId), eq(relations.targetEntityId, r.sourceEntityId)),
                    ),
                  ),
                )
                .all(),
            )
        : [];
    this.ctx.database.transaction(() => {
      this.db
        .update(relations)
        .set({ status, resolvedByUser: true, updatedAt })
        .where(
          inArray(
            relations.id,
            rows.map((r) => r.id),
          ),
        )
        .run();
      if (general.length)
        this.db
          .update(relations)
          .set({ status: 'outdated', updatedAt })
          .where(
            inArray(
              relations.id,
              general.map((r) => r.id),
            ),
          )
          .run();
      this.audit.log({
        action: status === 'confirmed' ? 'relation.confirmMany' : 'relation.rejectMany',
        actor: 'user',
        trigger: opts.trigger ?? 'manual',
        confirmed: true,
        entityIds: rows.map((r) => r.id).slice(0, 200),
        before: { count: rows.length, status: 'proposed' },
        after: { count: rows.length, status },
        undo: {
          type: DECIDE_MANY_UNDO_TYPE,
          data: {
            before: [...rows, ...general].map((r) => ({ id: r.id, status: r.status, resolvedByUser: r.resolvedByUser, updatedAt: r.updatedAt })),
            after: Object.fromEntries([...rows, ...general].map((r) => [r.id, updatedAt])),
          } satisfies DecideManyUndoData,
        },
      });
    });
    this.ctx.events.changed('knowledge');
    return rows.length;
  }

  /**
   * A topic or project with everything below it over confirmed „Unterthema von“ relations (#282) – itself first.
   * Search filters and knowledge questions on a topic take its subtopics along.
   */
  subtreeOf(id: string): string[] {
    return (
      this.ctx.database.sqlite
        .prepare(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT r.source_entity_id FROM relations r JOIN sub ON r.target_entity_id = sub.id
             WHERE r.relation_type = 'subtopic_of' AND r.status = 'confirmed') SELECT id FROM sub`,
        )
        .all(id) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** Every confirmed „Unterthema von“ (#282): child and parent – for the tree on the knowledge page. */
  hierarchy(): Array<{ childId: string; parentId: string }> {
    return this.ctx.database.sqlite
      .prepare(`SELECT source_entity_id AS childId, target_entity_id AS parentId FROM relations WHERE relation_type = 'subtopic_of' AND status = 'confirmed'`)
      .all() as Array<{ childId: string; parentId: string }>;
  }

  /** Opens or closes a case („Vorgang“, #286); logged with undo. */
  setCaseStatus(id: string, status: 'open' | 'closed', opts: { trigger?: string } = {}): GraphEntity {
    const row = this.db.select().from(entities).where(eq(entities.id, id)).get();
    if (row?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    const updatedAt = nowIso();
    this.db.update(entities).set({ status, updatedAt }).where(eq(entities.id, id)).run();
    this.audit.log({
      action: status === 'closed' ? 'case.close' : 'case.reopen',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: row.status },
      after: { status },
      undo: { type: CASE_UNDO_TYPE, data: { id, before: row.status, beforeUpdatedAt: row.updatedAt, afterUpdatedAt: updatedAt } },
    });
    this.ctx.events.changed('knowledge');
    return this.getEntity(id)!;
  }

  private linkUndoConflicts(d: LinkUndoData): string[] {
    const id = d.after?.id ?? d.before?.id;
    const now = id ? this.db.select().from(relations).where(eq(relations.id, id)).get() : undefined;
    if (d.after) {
      if (!now) return ['Die Verknüpfung existiert nicht mehr.'];
      if (now.status !== d.after.status || now.updatedAt !== d.after.updatedAt) return ['Die Verknüpfung wurde seither verändert.'];
      return [];
    }
    return now ? ['Die Verknüpfung existiert inzwischen wieder.'] : [];
  }

  private linkUndoRun(d: LinkUndoData): string {
    if (d.after && !d.before) this.db.delete(relations).where(eq(relations.id, d.after.id)).run();
    else if (d.before && d.after)
      this.db
        .update(relations)
        .set({ status: d.before.status, resolvedByUser: d.before.resolvedByUser, confidence: d.before.confidence, updatedAt: d.before.updatedAt })
        .where(eq(relations.id, d.before.id))
        .run();
    else if (d.before) this.db.insert(relations).values(d.before).onConflictDoNothing().run();
    this.ctx.events.changed('knowledge');
    return 'Verknüpfung zurückgesetzt.';
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

  /** Stores roles as info on the entity ("Chefin"); roles already known (case/umlaut-insensitive) are skipped. */
  addRoles(entityId: string, roles: string[]): GraphEntity {
    const row = this.db.select().from(entities).where(eq(entities.id, entityId)).get();
    if (!row) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    const merged = mergeRoles(row.roles, roles);
    if (merged.length === row.roles.length) return mapEntity(row);
    const updatedAt = nowIso();
    this.db.update(entities).set({ roles: merged, updatedAt }).where(eq(entities.id, entityId)).run();
    this.ctx.events.changed('knowledge');
    return mapEntity({ ...row, roles: merged, updatedAt });
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
   * `events.participants`, `documents.persons` and `documents.tags` (canonical target name, deduplicated). Merged-away names become aliases
   * of the target, their roles are added to the target's roles; the affected records are reindexed afterwards.
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

  /**
   * Renames an entity and updates the name lists that mention its former name (participants, document persons, tags).
   * `keepOldName` stores the former name as an alias. Recorded like a merge without sources, so the undo is exact.
   */
  async rename(id: string, name: string, opts: MergeOptions & { keepOldName?: boolean } = {}): Promise<{ auditId: string } | null> {
    const target = this.entityRow(id);
    if (!target) throw new AppError('validation_error', 'Umbenennen: Eintrag nicht gefunden.');
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw new AppError('validation_error', 'Der Name darf nicht leer sein.');
    if (clean === target.name) return null;
    const touched = new Set<string>([`entity:${id}`]);
    const reindex = emptyRefSets();
    const auditId = this.ctx.database.transaction(() => {
      const now = nowIso();
      const step: MergeStep = { target: { ...target }, sources: [], relationsDeleted: [], relationsUpdated: [], refs: [] };
      this.rehangReferences(step, now, touched, reindex, clean);
      const normalizedName = normalizeName(clean);
      const aliases = opts.keepOldName === false ? target.aliases : mergeAliases({ normalizedName, aliases: target.aliases }, [target.name]);
      this.db.update(entities).set({ name: clean, normalizedName, aliases, updatedAt: now }).where(eq(entities.id, id)).run();
      const data: MergeUndoData = { steps: [step], after: this.fingerprints([...touched]) };
      return this.audit.log({
        action: opts.action ?? 'entity.rename',
        actor: opts.actor ?? 'user',
        trigger: opts.trigger ?? 'manual',
        confirmed: true,
        entityIds: [id],
        before: { name: target.name },
        after: { name: clean },
        undo: { type: MERGE_UNDO_TYPE, data },
      });
    });
    this.ctx.events.changed('knowledge', 'documents', 'decisions', 'openItems', 'events');
    await this.runReindex(reindex);
    return { auditId };
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
    const name = req.targetName?.trim().replace(/\s+/g, ' ') || target.name;
    const renamed = name !== target.name;

    const relationsMoved = this.moveRelations(step, now, touched);
    const referencesUpdated = this.rehangReferences(step, now, touched, reindex, renamed ? name : undefined);

    // the target keeps the merged names (and its former name) as aliases and takes over a missing description
    const normalizedName = normalizeName(name);
    const aliases = mergeAliases({ normalizedName, aliases: target.aliases }, [
      ...(renamed ? [target.name] : []),
      ...sources.flatMap((s) => [s.name, ...s.aliases]),
    ]);
    const description = target.description ?? sources.find((s) => s.description)?.description ?? null;
    const roles = mergeRoles(target.roles, [...sources.flatMap((s) => s.roles), ...(req.addRoles ?? [])]);
    this.db.update(entities).set({ name, normalizedName, aliases, roles, description, updatedAt: now }).where(eq(entities.id, target.id)).run();
    touched.add(`entity:${target.id}`);

    this.db.delete(entities).where(inArray(entities.id, sourceIds)).run();
    for (const id of sourceIds) touched.add(`entity:${id}`);

    return {
      step,
      result: {
        targetId: target.id,
        targetName: name,
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
  /** `newName`: the target is renamed, so name lists mentioning its former name are updated as well. */
  private rehangReferences(step: MergeStep, now: string, touched: Set<string>, reindex: RefSets, newName?: string): number {
    const target = step.target;
    const targetName = newName ?? target.name;
    const sourceIds = step.sources.map((s) => s.id);
    const sourceSet = new Set(sourceIds);
    const sourceNames = new Set([
      ...step.sources.flatMap((s) => [s.normalizedName, ...s.aliases.map(normalizeName)]),
      ...(newName ? [target.normalizedName] : []),
    ]);
    const touchesTopics = step.sources.some((s) => TOPIC_OR_PROJECT.has(s.type));
    let updated = 0;
    for (const name of REF_TABLE_NAMES) {
      const spec = REF_TABLES[name];
      const tbl = spec.table as RefTableShape;
      const listCol = spec.lists[target.type as EntityType];
      const responsible = spec.responsible === true && target.type === 'person' && sourceIds.length > 0;
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
        if (listCol) next[listCol] = replaceNames(next[listCol] as string[], sourceNames, targetName);
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
        if (step.sources.length) this.db.insert(entities).values(step.sources).run();
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
    if (names.length === 0) return `Umbenennung rückgängig gemacht: „${data.steps[0]?.target.name ?? ''}“ wiederhergestellt.`;
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
      this.ctx.logger.warn('knowledge', 'Reindexing after merge failed', { error: err });
    }
  }
}
