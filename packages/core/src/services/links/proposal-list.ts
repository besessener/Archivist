import { RELATION_METHOD_LABELS, type EntityType, type GraphRelation, type RelationMethod } from '@archivist/shared';
import { LINK_PROPOSAL_METHODS, OWN_FLOW_TYPES, sqlList, type LinkDeps } from './entries';

export interface LinkProposal {
  relation: GraphRelation;
  source: { id: string; type: EntityType; name: string };
  target: { id: string; type: EntityType; name: string };
  /** The group the proposal belongs to (method or source entry). */
  groupKey: string;
}

export interface LinkProposalPage {
  /** All open proposals (not only this page). */
  total: number;
  /** Every group with its number of proposals, in the order of the list. */
  groups: Array<{ key: string; label: string; count: number }>;
  items: LinkProposal[];
}

export type ProposalGrouping = 'method' | 'entry';

/** No automatic method adds proposals while this many wait for review: more come once the user has decided (#361). */
const MAX_OPEN_PROPOSALS = 20;

/** The open proposals the list shows; binds `@minConfidence`. */
function proposalSql(groupBy: ProposalGrouping) {
  return {
    from: `FROM relations r JOIN entities s ON s.id = r.source_entity_id JOIN entities t ON t.id = r.target_entity_id
        WHERE r.status = 'proposed' AND r.method IN (${sqlList(LINK_PROPOSAL_METHODS)}) AND (r.relation_type NOT IN (${sqlList(OWN_FLOW_TYPES)}) OR r.method = 'refinement')
          AND s.duplicate_of_id IS NULL AND t.duplicate_of_id IS NULL AND r.confidence >= @minConfidence`,
    key: groupBy === 'method' ? 'r.method' : 'r.source_entity_id',
    sort: groupBy === 'method' ? 'r.method' : 's.normalized_name, r.source_entity_id',
  };
}

/** The open link proposals for review in one place (#280); contradictions, versions and duplicates have flows of their own. */
export class LinkProposalList {
  constructor(private readonly deps: LinkDeps) {}

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  /** Grouped by method or by entry, each with its evidence, paged with the total – not capped. */
  proposals(options: { groupBy?: ProposalGrouping; limit?: number; offset?: number } = {}): LinkProposalPage {
    const groupBy = options.groupBy ?? 'method';
    const query = proposalSql(groupBy);
    const params = { minConfidence: this.deps.minConfidence() };
    const groups = (
      this.sqlite
        .prepare(
          `SELECT ${query.key} AS key, min(s.name) AS name, count(*) AS count ${query.from} GROUP BY ${query.key} ORDER BY min(${query.sort.split(',')[0]}), ${query.key}`,
        )
        .all(params) as Array<{ key: string; name: string; count: number }>
    ).map((group) => ({
      key: group.key,
      label: groupBy === 'method' ? (RELATION_METHOD_LABELS[group.key as RelationMethod] ?? group.key) : group.name,
      count: group.count,
    }));
    const rows = this.sqlite
      .prepare(`SELECT r.id AS id, ${query.key} AS groupKey ${query.from} ORDER BY ${query.sort}, r.confidence DESC, r.id LIMIT ? OFFSET ?`)
      .all(params, options.limit ?? 50, options.offset ?? 0) as Array<{ id: string; groupKey: string }>;
    const items = rows.flatMap((row) => this.proposalOf(row));
    return { total: groups.reduce((sum, group) => sum + group.count, 0), groups, items };
  }

  private proposalOf(row: { id: string; groupKey: string }): LinkProposal[] {
    const relation = this.deps.graph.getRelation(row.id);
    const source = relation && this.deps.graph.getEntity(relation.sourceEntityId);
    const target = relation && this.deps.graph.getEntity(relation.targetEntityId);
    if (!relation || !source || !target) return [];
    return [
      {
        relation,
        source: { id: source.id, type: source.type, name: source.name },
        target: { id: target.id, type: target.type, name: target.name },
        groupKey: row.groupKey,
      },
    ];
  }

  /** Confirms or rejects every open proposal of a group („Alle bestätigen“, #280) – one undo step. */
  decideGroup(group: { groupBy: ProposalGrouping; key: string }, decision: { status: 'confirmed' | 'rejected'; trigger?: string }): number {
    const query = proposalSql(group.groupBy);
    const rows = this.sqlite
      .prepare(`SELECT r.id AS id ${query.from} AND ${query.key} = @key`)
      .all({ minConfidence: this.deps.minConfidence(), key: group.key }) as Array<{ id: string }>;
    const ids = rows.map((row) => row.id);
    return this.deps.graph.decideRelations(ids, { status: decision.status, trigger: decision.trigger });
  }
}

/** True while the open proposals the list and its badge count reach the cap: then no automatic method adds more (#361). */
export function proposalsAtLimit(deps: LinkDeps): boolean {
  const open = deps.ctx.database.sqlite.prepare(`SELECT count(*) AS c ${proposalSql('method').from}`).get({ minConfidence: deps.minConfidence() }) as {
    c: number;
  };
  return open.c >= MAX_OPEN_PROPOSALS;
}
