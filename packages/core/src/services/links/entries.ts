import type { EntityType, RelationMethod } from '@archivist/shared';
import type { AppContext } from '../../context';
import type { AppStateService } from '../app-state';
import type { LinkOptions, LinkResult } from '../graph/relations';
import type { RelationKey } from '../graph/rows';
import type { InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { LinkThresholds } from '../link-thresholds';
import type { SearchService } from '../search';

/** Everything the link methods work with. */
export interface LinkDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  search: SearchService;
  insights: InsightService;
  appState: AppStateService;
  thresholds?: LinkThresholds;
  /** The user's lowest confidence for a proposal (setting `links.minConfidence`). */
  minConfidence: () => number;
}

/** Knowledge entries the link methods connect (documents only once archived or indexed). */
export const LINK_ENTRY_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];
/** Entries a topic can be assigned to with the same function as in the UI (`set_metadata` / bulk assignment). */
export const TOPIC_ENTRY_TYPES: EntityType[] = ['document', 'decision', 'task', 'question', 'event'];
/** Methods whose proposals are reviewed in the list of link proposals (#280); field mirrors and own flows are not. */
export const LINK_PROPOSAL_METHODS: RelationMethod[] = ['similarity', 'mention', 'co_origin', 'date_person', 'analysis', 'agent', 'wikilink', 'refinement'];
/** Relation types with a flow of their own (contradictions, versions, duplicates). */
export const OWN_FLOW_TYPES = ['contradicts', 'supersedes', 'duplicate_of'];

/** The values as a quoted SQL list (constants only, never user input). */
export const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(',');

/** SQL for an entry that counts: not discarded as a duplicate, documents only when archived or indexed. */
export const entrySql = (alias: string, types: EntityType[]): string =>
  `${alias}.type IN (${sqlList(types)}) AND ${alias}.duplicate_of_id IS NULL AND (${alias}.type <> 'document' OR EXISTS (SELECT 1 FROM documents d WHERE d.id = ${alias}.id AND d.status IN ('archived','indexed_only')))`;

type Sqlite = AppContext['database']['sqlite'];

/** Counts as a knowledge entry for the link methods: not a discarded duplicate, a document only when archived or indexed. */
export function isEntry(sqlite: Sqlite, id: string): boolean {
  return Boolean(sqlite.prepare(`SELECT 1 FROM entities e WHERE e.id = ? AND ${entrySql('e', LINK_ENTRY_TYPES)}`).get(id));
}

/** Any current or rejected relation between the two (in either direction): no new proposal for them. */
export function isConnected(sqlite: Sqlite, pair: { a: string; b: string }): boolean {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM relations WHERE ((source_entity_id = ? AND target_entity_id = ?) OR (source_entity_id = ? AND target_entity_id = ?)) AND status IN ('proposed','confirmed','rejected') LIMIT 1`,
      )
      .get(pair.a, pair.b, pair.b, pair.a),
  );
}

/** A current (proposed or confirmed) relation of any type between the two. */
export function isLinked(sqlite: Sqlite, pair: { a: string; b: string }): boolean {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM relations WHERE ((source_entity_id = ? AND target_entity_id = ?) OR (source_entity_id = ? AND target_entity_id = ?)) AND status IN ('proposed','confirmed') LIMIT 1`,
      )
      .get(pair.a, pair.b, pair.b, pair.a),
  );
}

/** Open proposals of a method at an entry (either end) that reach the user's minimum confidence. */
export function openProposalsAt(deps: LinkDeps, at: { id: string; method: RelationMethod }): number {
  const row = deps.ctx.database.sqlite
    .prepare(
      `SELECT count(*) AS c FROM relations WHERE (source_entity_id = @id OR target_entity_id = @id) AND status = 'proposed' AND method = @method AND confidence >= @minConfidence`,
    )
    .get({ ...at, minConfidence: deps.minConfidence() }) as { c: number };
  return row.c;
}

/** What an automatic method proposes: always `proposed`, with the confidence the user's minimum is measured against. */
type ProposalOptions = Omit<LinkOptions, 'status' | 'confidence'> & { confidence: number };

/** Reaches the user's minimum confidence for proposals (setting `links.minConfidence`). */
export const reachesMinConfidence = (deps: Pick<LinkDeps, 'minConfidence'>, confidence: number): boolean => confidence >= deps.minConfidence();

/** Every automatic method proposes through here (#381): below the user's minimum confidence nothing is stored. */
export function proposeLink(deps: LinkDeps, proposal: { key: RelationKey; options: ProposalOptions }): LinkResult | null {
  if (!reachesMinConfidence(deps, proposal.options.confidence)) return null;
  return deps.graph.link(proposal.key, { ...proposal.options, status: 'proposed' });
}

/** Reads a JSON list from the app state; anything unreadable counts as empty. */
export function storedList(appState: AppStateService, key: string): unknown[] {
  try {
    const value = JSON.parse(appState.get(key) ?? '[]') as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
