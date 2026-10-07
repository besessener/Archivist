import type { EntityType, GraphRelation } from '@archivist/shared';
import { relationReason } from '../graph/relation-reason';
import { otherEndOf } from '../graph/rows';
import { isEntry, LINK_ENTRY_TYPES, type LinkDeps } from './entries';

/** An entry related to another one – directly or over shared topics, projects, persons, tags or cases (#276). */
export interface RelatedItem {
  entity: { id: string; type: EntityType; name: string; description: string | null };
  /** Strength: kind and number of the connections. */
  score: number;
  /** Plain-language reason, e.g. „gleiches Projekt „Hausbau“ + gleiche Person „Anna““. */
  reason: string;
  /** The direct relation, if any (proposals can be confirmed or rejected right there). */
  relation: GraphRelation | null;
  shared: Array<{ id: string; type: EntityType; name: string }>;
}

type SharedNode = RelatedItem['shared'][number];
interface Connection {
  score: number;
  relation: GraphRelation | null;
  shared: SharedNode[];
}

/** Weight of a shared node for the strength of an indirect connection (#276). */
const SHARED_WEIGHT: Partial<Record<EntityType, number>> = { project: 4, case: 4, topic: 3, person: 2, tag: 1 };
const SHARED_LABEL: Partial<Record<EntityType, string>> = {
  project: 'gleiches Projekt',
  case: 'gleicher Vorgang',
  topic: 'gleiches Thema',
  person: 'gleiche Person',
  tag: 'gleicher Tag',
};
/** Order of the shared nodes in a reason. */
const SHARED_ORDER: EntityType[] = ['project', 'case', 'topic', 'person', 'tag'];
/** A node shared with more entries than this says little about two of them (e.g. a tag on every document). */
const MAX_HUB_MEMBERS = 500;

function reasonOf(connection: Connection): string {
  const parts: string[] = [];
  if (connection.relation) parts.push(relationReason(connection.relation));
  for (const type of SHARED_ORDER) {
    const names = connection.shared.filter((node) => node.type === type).map((node) => `„${node.name}“`);
    if (names.length) parts.push(`${SHARED_LABEL[type]} ${names.join(', ')}`);
  }
  return parts.join(' + ');
}

const bySharedOrder = (x: SharedNode, y: SharedNode) => SHARED_ORDER.indexOf(x.type) - SHARED_ORDER.indexOf(y.type) || x.name.localeCompare(y.name, 'de');

/** Related entries of an entry (#276): direct relations and shared topics, projects, persons, tags and cases. */
export class RelatedItems {
  constructor(private readonly deps: LinkDeps) {}

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  /** Sorted by strength, each with its reason, paged; rejected pairs and non-entries are left out. */
  related(id: string, page: { limit?: number; offset?: number }): { total: number; items: RelatedItem[] } {
    const connections = new Map<string, Connection>();
    const slot = (other: string) => {
      const connection = connections.get(other) ?? { score: 0, relation: null, shared: [] };
      connections.set(other, connection);
      return connection;
    };
    const hubs = this.addDirect(id, slot);
    this.addShared({ id, hubs, slot });
    const rejected = this.rejectedOthers(id);
    const all = [...connections.entries()]
      .filter(([other, connection]) => connection.score > 0 && !rejected.has(other) && isEntry(this.sqlite, other))
      .flatMap(([other, connection]) => this.itemOf(other, connection))
      .toSorted((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name, 'de'));
    const offset = page.offset ?? 0;
    return { total: all.length, items: all.slice(offset, offset + (page.limit ?? 10)) };
  }

  private rejectedOthers(id: string): Set<string> {
    const rejected = this.deps.graph.relationsOf(id, { statuses: ['rejected'] });
    return new Set(rejected.flatMap((relation) => (relation.relationType === 'duplicate_of' ? [] : [otherEndOf(relation, id)])));
  }

  /** Confirmed relations and the proposals that reach the user's minimum confidence. */
  private shownRelations(id: string): GraphRelation[] {
    const min = this.deps.minConfidence?.() ?? 0;
    return this.deps.graph
      .relationsOf(id, { statuses: ['proposed', 'confirmed'] })
      .filter((relation) => relation.status === 'confirmed' || relation.confidence >= min);
  }

  /** Scores the direct relations to entries; returns the shared nodes (hubs) the entry is linked to, not the user's own person. */
  private addDirect(id: string, slot: (other: string) => Connection): SharedNode[] {
    const hubs: SharedNode[] = [];
    for (const relation of this.shownRelations(id)) {
      const otherId = otherEndOf(relation, id);
      const other = this.deps.graph.getEntity(otherId);
      if (!other) continue;
      if (SHARED_WEIGHT[other.type] !== undefined) {
        if (!other.isSelf && !hubs.some((hub) => hub.id === other.id)) hubs.push({ id: other.id, type: other.type, name: other.name });
        continue;
      }
      if (relation.relationType === 'duplicate_of' || !LINK_ENTRY_TYPES.includes(other.type)) continue;
      const connection = slot(otherId);
      const weight = (relation.status === 'confirmed' ? 10 : 5) + relation.confidence;
      if (!connection.relation || weight > connection.score) connection.relation = relation;
      connection.score += weight;
    }
    return hubs;
  }

  /** Scores the entries that share a hub with the entry. */
  private addShared(request: { id: string; hubs: SharedNode[]; slot: (other: string) => Connection }): void {
    const members = this.sqlite.prepare(
      `SELECT CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END AS other
       FROM relations r WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.status IN ('proposed','confirmed')`,
    );
    for (const hub of request.hubs) {
      const others = [...new Set((members.all(hub.id, hub.id, hub.id) as Array<{ other: string }>).map((member) => member.other))];
      if (others.length > MAX_HUB_MEMBERS) continue;
      for (const other of others.filter((x) => x !== request.id)) {
        const connection = request.slot(other);
        connection.score += SHARED_WEIGHT[hub.type] ?? 0;
        connection.shared.push(hub);
      }
    }
  }

  private itemOf(other: string, connection: Connection): RelatedItem[] {
    const entity = this.deps.graph.getEntity(other);
    if (!entity) return [];
    return [
      {
        entity: { id: entity.id, type: entity.type, name: entity.name, description: entity.description },
        score: Math.round(connection.score * 100) / 100,
        reason: reasonOf(connection),
        relation: connection.relation,
        shared: connection.shared.toSorted(bySharedOrder),
      },
    ];
  }
}
