import type { EntityDetail, EntityType, GraphEntity, GraphRelation, RelationMethod, RelationStatus, RelationType } from '@archivist/shared';
import type { AppContext } from '../context';
import type { AuditService } from './audit';
import { GraphEntities, type EntityQuery, type NewEntity, type NodeSnapshot } from './graph/entities';
import { subtopicPairs, subtreeOf } from './graph/hierarchy';
import { LinkUndo, type LinkUndoData } from './graph/link-undo';
import { EntityMerges } from './graph/merge';
import type { MergeBatchResult, MergeOptions, MergeReindexer, MergeRequest, MergeResult } from './graph/merge-types';
import type { NeighborhoodGraph, NeighborhoodOptions } from './graph/neighborhood';
import { GraphRelations, type LinkOptions, type LinkResult, type RelationChangeSet, type SystemUnlink } from './graph/relations';
import type { RelationKey } from './graph/rows';
import { UserLinks, type LinkChange, type LinkChangeOptions, type LinkEntriesOptions } from './graph/user-links';
import { GraphViews, type RelatedEntry, type RelatedQuery } from './graph/views';
import type { UndoService } from './undo';

export type { NodeSnapshot } from './graph/entities';
export { LINK_MANY_UNDO_TYPE, type LinkManyUndoData } from './graph/link-undo';
export type { MergeRequest } from './graph/merge-types';
export { relationReason } from './graph/relation-reason';
export type { RelationChangeSet } from './graph/relations';

export type KnowledgeGraphServiceDeps = { ctx: AppContext; audit: AuditService; undo: UndoService };

/** Knowledge graph over entity and relation tables in SQLite. */
export class KnowledgeGraphService {
  private readonly entities: GraphEntities;
  private readonly relations: GraphRelations;
  private readonly views: GraphViews;
  private readonly userLinks: UserLinks;
  private readonly merges: EntityMerges;

  private readonly ctx: AppContext;

  constructor(deps: KnowledgeGraphServiceDeps) {
    ({ ctx: this.ctx } = deps);
    const { ctx, audit, undo } = deps;
    this.entities = new GraphEntities(ctx);
    this.relations = new GraphRelations(ctx);
    this.views = new GraphViews(this.entities, this.relations);
    this.userLinks = new UserLinks({ ctx, audit, graph: { entities: this.entities, relations: this.relations } });
    this.merges = new EntityMerges({ ctx, audit, undo });
    new LinkUndo(ctx).register(undo);
  }

  getEntity(id: string): GraphEntity | undefined {
    return this.entities.get(id);
  }

  /** The entity of this type and name, created if missing; `fromDocument` keeps a new topic/project unconfirmed (#199). */
  ensureEntity(entity: NewEntity): GraphEntity {
    return this.entities.ensure(entity);
  }

  /** The user accepts a topic/project taken from a document: from now on it is listed in LLM prompts. */
  confirmEntity(id: string): GraphEntity {
    return this.entities.confirm(id);
  }

  findByName(type: EntityType, name: string): GraphEntity | undefined {
    return this.entities.findByName(type, name);
  }

  /** Exact (normalized) name first, otherwise a unique alias of the type. */
  findByNameOrAlias(type: EntityType, name: string): GraphEntity | undefined {
    return this.entities.findByNameOrAlias(type, name);
  }

  /** Registers documents/decisions/open items as nodes with their own (given) id. */
  registerNode(node: { type: EntityType; id: string; name: string; description?: string | null }): void {
    this.entities.register(node);
  }

  removeNode(id: string): void {
    this.entities.remove(id);
  }

  /** Captures a node and its relations (for the undo of a later `removeNode`); `null` if the node does not exist. */
  snapshotNode(id: string): NodeSnapshot | null {
    return this.entities.snapshot(id);
  }

  /** Restores a node captured by `snapshotNode`; returns the number of relations skipped because their other end is gone. */
  restoreNode(snapshot: NodeSnapshot): number {
    return this.entities.restore(snapshot);
  }

  listEntities(opts: EntityQuery = {}): Array<GraphEntity & { relationCount: number }> {
    return this.entities.list(opts);
  }

  /** Remembers `alias` as an alternative name of the entity (no-op if it equals the name or a known alias). */
  addAlias(entityId: string, alias: string): GraphEntity {
    return this.entities.addAlias(entityId, alias);
  }

  /** Forgets an alias again (undo of {@link addAlias}). */
  removeAlias(entityId: string, alias: string): GraphEntity {
    return this.entities.removeAlias(entityId, alias);
  }

  /** Stores roles as info on the entity ("Chefin"); roles already known (case/umlaut-insensitive) are skipped. */
  addRoles(entityId: string, roles: string[]): GraphEntity {
    return this.entities.addRoles(entityId, roles);
  }

  /** Creates a relation (rejected ones are not revived, confirmed ones never downgraded); `created` tells whether it is new. */
  link(key: RelationKey, opts: LinkOptions = {}): LinkResult | null {
    return this.relations.link(key, opts);
  }

  getRelation(id: string): GraphRelation | undefined {
    return this.relations.get(id);
  }

  deleteRelation(id: string): void {
    this.relations.delete(id);
  }

  /** Sets the status as a user decision (`by: 'user'`), which field sync never overrides afterwards. */
  setRelationStatus(id: string, { status, by = 'user' }: { status: RelationStatus; by?: 'user' | 'system' }): GraphRelation {
    return this.relations.setStatus(id, { status, by });
  }

  relationsOf(entityId: string, opts: { statuses?: RelationStatus[]; types?: RelationType[] } = {}): GraphRelation[] {
    return this.relations.of(entityId, opts);
  }

  /** A relation between the two that the user rejected (never proposed again, #270); a rejected duplicate only with `includeDuplicateOf`. */
  rejectedBetween(pair: { a: string; b: string; includeDuplicateOf?: boolean }): GraphRelation | undefined {
    return this.relations.rejectedBetween(pair);
  }

  /** Marks the system's current relations of a changed field as outdated, except those to `keepIds`; returns their ids. */
  unlinkSystemRelations(unlink: SystemUnlink): string[] {
    return this.relations.unlinkSystemRelations(unlink);
  }

  /** Runs `fn` and records how the relations touching `entityId` changed, for `revertRelationChanges`. */
  trackRelationChanges<T>(entityId: string, fn: () => T): { result: T; changes: RelationChangeSet } {
    return this.relations.trackChanges(entityId, fn);
  }

  /** Conflicts (German) that prevent reverting `changes`: relations changed or removed since the edit. */
  relationChangeConflicts(changes: RelationChangeSet | undefined): string[] {
    return this.relations.changeConflicts(changes);
  }

  /** Restores the relations recorded by `trackRelationChanges` (call inside the undo transaction). */
  revertRelationChanges(changes: RelationChangeSet | undefined): void {
    this.relations.revertChanges(changes);
  }

  /** Entities connected to `entityId` via active (not rejected) relations. */
  neighbors(entityId: string, opts: { types?: EntityType[]; relationTypes?: RelationType[] } = {}): GraphEntity[] {
    return this.views.neighbors(entityId, opts);
  }

  /** Neighbours up to `depth` (1 or 2) with their reasons – „Verwandte Einträge“ (#276) and the agent's research (#289). */
  related(id: string, opts: RelatedQuery = {}): RelatedEntry[] {
    return this.views.related(id, opts);
  }

  /** Rejected pairs of an entry (the agent names them on request, #306). */
  rejectedPairsOf(id: string): Array<{ relation: GraphRelation; other: GraphEntity }> {
    return this.views.rejectedPairsOf(id);
  }

  getDetail(id: string): EntityDetail {
    return this.views.detail(id);
  }

  /** The surroundings of an entry as a graph (#288), hubs grouped; rejected and outdated relations are never shown. */
  neighborhood(id: string, opts: NeighborhoodOptions = {}): NeighborhoodGraph {
    return this.views.neighborhood(id, opts);
  }

  /** A topic or project with everything below it over confirmed „Unterthema von“ (#282) – itself first. */
  subtreeOf(id: string): string[] {
    return subtreeOf(this.ctx.database.sqlite, id);
  }

  /** Every confirmed „Unterthema von“ (#282): child and parent – for the tree on the knowledge page. */
  hierarchy(): Array<{ childId: string; parentId: string }> {
    return subtopicPairs(this.ctx.database.sqlite);
  }

  /** Links two entries (#277): `confirmed` when the user asked for it, else a proposal; rejected pairs are refused. */
  linkEntries(key: RelationKey, opts: LinkEntriesOptions): { relation: GraphRelation; created: boolean } {
    return this.userLinks.linkEntries(key, opts);
  }

  /** Links entries with one target as the user's choice (#286, #291): one audit entry, one undo; returns the number changed. */
  linkMany(
    request: { sourceIds: string[]; targetId: string; relationType: RelationType },
    opts: { trigger?: string; action?: string; method?: RelationMethod } = {},
  ): number {
    return this.userLinks.linkMany(request, opts);
  }

  /** Adds confirmed links and removes others in ONE audited, undoable step (#287, #291); returns the number changed. */
  changeLinks(change: LinkChange, opts: LinkChangeOptions = {}): number {
    return this.userLinks.changeLinks(change, opts);
  }

  /** {@link changeLinks} without its audit entry – for an action that logs several parts as one undo step (#291). */
  applyLinkChanges(change: LinkChange, method?: RelationMethod): { items: LinkUndoData[]; entityIds: Set<string> } {
    return this.userLinks.applyLinkChanges(change, method);
  }

  /** Removes a relation the user (or the agent on the user's request) no longer wants; logged with undo. */
  unlinkEntries(relationId: string, opts: { trigger?: string } = {}): GraphRelation {
    return this.userLinks.unlinkEntries(relationId, opts);
  }

  /** Confirms or rejects a relation as the user's decision (#306); logged with undo. */
  decideRelation(relationId: string, decision: { status: 'confirmed' | 'rejected'; trigger?: string }): GraphRelation {
    return this.userLinks.decideRelation(relationId, decision);
  }

  /** Decides several open proposals at once (#280): one audit entry, one undo; returns the number decided. */
  decideRelations(ids: string[], decision: { status: 'confirmed' | 'rejected'; trigger?: string }): number {
    return this.userLinks.decideRelations(ids, decision);
  }

  /** Opens or closes a case („Vorgang“, #286); logged with undo. */
  setCaseStatus(id: string, change: { status: 'open' | 'closed'; trigger?: string }): GraphEntity {
    return this.userLinks.setCaseStatus(id, change);
  }

  /** Sets the callback that rebuilds search index entries of records touched by a merge or its undo. */
  setReindexer(reindexer: MergeReindexer): void {
    this.merges.setReindexer(reindexer);
  }

  /** Merges one or more entities into a target (see {@link mergeMany}); one audit entry, undoable. */
  async merge(request: MergeRequest, opts: MergeOptions = {}): Promise<MergeResult & { auditId: string }> {
    const { auditId, results } = await this.merges.mergeMany([request], opts);
    return { auditId, ...results[0]! };
  }

  /** Merges atomically as ONE undoable audit entry: relations, references and name lists move to the target, names become aliases. */
  async mergeMany(requests: MergeRequest[], opts: MergeOptions = {}): Promise<MergeBatchResult> {
    return this.merges.mergeMany(requests, opts);
  }

  /** Renames an entity and the name lists mentioning it; `keepOldName` keeps the former name as an alias. */
  async rename(request: { id: string; name: string }, opts: MergeOptions & { keepOldName?: boolean } = {}): Promise<{ auditId: string } | null> {
    return this.merges.rename(request, opts);
  }
}
