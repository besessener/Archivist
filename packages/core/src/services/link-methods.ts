import type { EntityType } from '@archivist/shared';
import type { CreatedEntry } from '../util/origin-scope';
import { LinkBackfill, type BackfillOptions, type BackfillResult, type NoteAnalyzer } from './links/backfill';
import { CapturedSuggestions, type CapturedSuggestion } from './links/captured';
import { LinkCandidates, type LinkCandidate } from './links/candidates';
import { CoOriginLinks } from './links/co-origin';
import { isEntry, type LinkDeps } from './links/entries';
import { LinkageMetricsLog, type LinkageMetrics, type LinkageSnapshot } from './links/metrics';
import { OrphanLinks, type OrphanPage } from './links/orphans';
import { LinkProposalList, type LinkProposalPage, type ProposalGrouping } from './links/proposal-list';
import { RelatedItems, type RelatedItem } from './links/related-items';
import { TopicClusters, type TopicCluster, type TopicNamer } from './links/topic-clusters';

export { MIN_SIMILARITY, type LinkCandidate } from './links/candidates';
export { ORPHAN_INSIGHT } from './links/orphans';
export type { TopicCluster } from './links/topic-clusters';

/** The fixed link methods of Epic #269, shared by the UI and the agent tools (#313); they only PROPOSE, confirming is the user's. */
export class LinkMethodsService {
  private readonly deps: LinkDeps;
  private readonly linkCandidates: LinkCandidates;
  private readonly proposalList: LinkProposalList;
  private readonly relatedItems: RelatedItems;
  private readonly orphanLinks: OrphanLinks;
  private readonly linkage: LinkageMetricsLog;
  private readonly topicClusters: TopicClusters;
  private readonly coOrigin: CoOriginLinks;
  private readonly captured: CapturedSuggestions;
  private readonly runs: LinkBackfill;

  constructor(deps: LinkDeps) {
    this.deps = deps;
    this.linkCandidates = new LinkCandidates(this.deps);
    this.proposalList = new LinkProposalList(this.deps);
    this.relatedItems = new RelatedItems(this.deps);
    this.orphanLinks = new OrphanLinks(this.deps, this.linkCandidates);
    this.linkage = new LinkageMetricsLog(this.deps, {
      orphans: () => this.orphanLinks.orphans({ limit: 1 }).total,
      openProposals: () => this.proposalList.proposals({ limit: 1 }).total,
    });
    this.topicClusters = new TopicClusters(this.deps, this.linkCandidates);
    this.coOrigin = new CoOriginLinks(this.deps);
    this.captured = new CapturedSuggestions(this.deps, this.linkCandidates);
    this.runs = new LinkBackfill(this.deps, { candidates: this.linkCandidates, coOrigin: this.coOrigin });
  }

  /** The analysis of notes (#273) for the retroactive run; returns the number of new proposals. */
  setNoteAnalyzer(analyzer: NoteAnalyzer): void {
    this.runs.setNoteAnalyzer(analyzer);
  }

  /** A better name for a new topic from a group (#281, the LLM where the privacy mode allows it). */
  setTopicNamer(namer: TopicNamer): void {
    this.topicClusters.setNamer(namer);
  }

  /** Counts as a knowledge entry for the link methods: not a discarded duplicate, a document only when archived or indexed. */
  isEntry(id: string): boolean {
    return isEntry(this.deps.ctx.database.sqlite, id);
  }

  /** Similar entries and mentioned topics/projects of an entry (#271, #283), without linked or rejected pairs. */
  async candidates(entityId: string, opts: { limit?: number; types?: EntityType[] } = {}): Promise<LinkCandidate[]> {
    return this.linkCandidates.candidates(entityId, opts);
  }

  /** Open link proposals grouped by method or entry, paged with the total (#280). */
  proposals(opts: { groupBy?: ProposalGrouping; limit?: number; offset?: number } = {}): LinkProposalPage {
    return this.proposalList.proposals(opts);
  }

  /** Confirms or rejects every open proposal of a group („Alle bestätigen“, #280) – one undo step. */
  decideGroup(groupBy: ProposalGrouping, key: string, decision: 'confirmed' | 'rejected', opts: { trigger?: string } = {}): number {
    return this.proposalList.decideGroup({ groupBy, key }, { status: decision, trigger: opts.trigger });
  }

  /** Related entries (#276): direct relations and shared topics, projects, persons, tags and cases, by strength, paged. */
  related(id: string, opts: { limit?: number; offset?: number } = {}): { total: number; items: RelatedItem[] } {
    return this.relatedItems.related(id, opts);
  }

  /** Entries without any confirmed or proposed relation (#290); a folder alone does not count. */
  orphans(opts: { limit?: number; offset?: number } = {}): OrphanPage {
    return this.orphanLinks.orphans(opts);
  }

  /** Archive check step (#290): proposes targets for entries without a link and keeps one bundled hint about them. */
  async checkOrphans(opts: { propose?: boolean; maxEntries?: number; signal?: AbortSignal } = {}): Promise<{ pending: number; proposed: number }> {
    return this.orphanLinks.checkOrphans(opts);
  }

  /** How well the archive is linked right now, with the history of the archive checks (#292). */
  metrics(): LinkageMetrics {
    return this.linkage.metrics();
  }

  /** Stores the current metrics as one point of the history; called by every archive check (#292). */
  recordMetrics(): LinkageSnapshot {
    return this.linkage.recordMetrics();
  }

  /** Groups of similar entries without a topic (#281); groups the user already answered are not offered again. */
  async clusters(opts: { minSize?: number; maxEntries?: number; signal?: AbortSignal } = {}): Promise<TopicCluster[]> {
    return this.topicClusters.clusters(opts);
  }

  /** Proposes each new group of similar entries without a topic as a new topic (#281); returns the number of new proposals. */
  async proposeClusterTopics(opts: { signal?: AbortSignal } = {}): Promise<number> {
    return this.topicClusters.proposeClusterTopics(opts);
  }

  /** „Neues Thema ‚…‘ anlegen?“ (#281): nothing changes before the user agrees. */
  proposeTopic(name: string, memberIds: string[], opts: { conversationId?: string | null } = {}): { insightId: string; actionId: string | null } {
    return this.topicClusters.proposeTopic({ name, memberIds }, opts);
  }

  /** Link suggestions right after capturing in the chat (#283), stored as proposals. */
  async suggestForCaptured(entries: CreatedEntry[], opts: { limit?: number } = {}): Promise<CapturedSuggestion[]> {
    return this.captured.suggestForCaptured(entries, opts);
  }

  /** Entries created by the same chat message belong together (#272); returns the number of new proposals. */
  linkCreatedTogether(entries: CreatedEntry[], opts: { evidence: string; sourceIds?: string[] }): number {
    return this.coOrigin.linkCreatedTogether(entries, opts);
  }

  /** Entries extracted from the same document belong together (#272). */
  linkSameDocument(entryId: string): number {
    return this.coOrigin.linkSameDocument(entryId);
  }

  /** Same-day entries with a shared person belong together (#278). */
  proposeSameDayPerson(id: string): number {
    return this.coOrigin.proposeSameDayPerson(id);
  }

  /** Proposes the open cases whose confirmed members are similar to the entry (#286). */
  async proposeCases(id: string): Promise<number> {
    return this.linkCandidates.proposeCases(id);
  }

  /** Proposes similar entries as `related_to` (#271), at most `max` open ones per entry. */
  async proposeSimilar(id: string, opts: { max?: number } = {}): Promise<number> {
    return this.linkCandidates.proposeSimilar(id, opts);
  }

  /** Remembers entries to look for similar ones (after indexing, #271); returns true if one of them counts. */
  queueSimilar(ids: string[]): boolean {
    return this.runs.queueSimilar(ids);
  }

  /** Works through the remembered entries (job `links.similar`). */
  async runPendingSimilar(opts: { max?: number; signal?: AbortSignal } = {}): Promise<{ processed: number; proposed: number }> {
    return this.runs.runPendingSimilar(opts);
  }

  /** The retroactive run starts again from the first entry (e.g. once after an update that brought new methods). */
  restartBackfill(): void {
    this.runs.restart();
  }

  /** Retroactive link run (#279), resumable: returns when `maxEntries` are done, the signal aborts or everything is done. */
  async backfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
    return this.runs.backfill(opts);
  }
}
