import type { EntityType, GraphEntity, GraphRelation, RelationStatus, RelationType } from '@archivist/shared';
import { otherEndOf } from './rows';

/** The surroundings of an entry for the graph view (#288). */
export interface NeighborhoodGraph {
  centerId: string;
  nodes: Array<{ id: string; type: EntityType; name: string; depth: number; count: number | null; status: string | null }>;
  edges: Array<{ id: string; source: string; target: string; relationType: RelationType; status: RelationStatus; grouped?: boolean }>;
  /** More nodes exist than were returned. */
  truncated: boolean;
}

export interface NeighborhoodOptions {
  depth?: number;
  relationTypes?: RelationType[];
  entityTypes?: EntityType[];
  statuses?: Array<'proposed' | 'confirmed'>;
  maxNodes?: number;
}

/** What the neighbourhood reads from the graph. */
export interface GraphReader {
  getEntity(id: string): GraphEntity | undefined;
  relationsOf(entityId: string, filter: { statuses: RelationStatus[] }): GraphRelation[];
}

type Node = NeighborhoodGraph['nodes'][number];
type Edge = NeighborhoodGraph['edges'][number];
interface Neighbor {
  relation: GraphRelation;
  other: GraphEntity;
}

/** Neighbours of one kind beyond this many are shown as one group node in the graph view (#288). */
const HUB_GROUP = 12;

const toEdge = (relation: GraphRelation): Edge => ({
  id: relation.id,
  source: relation.sourceEntityId,
  target: relation.targetEntityId,
  relationType: relation.relationType,
  status: relation.status,
});

const clamp = (value: number, range: { min: number; max: number }) => Math.min(Math.max(value, range.min), range.max);

function groupByType(neighbors: Neighbor[]): Map<EntityType, Neighbor[]> {
  const byType = new Map<EntityType, Neighbor[]>();
  for (const neighbor of neighbors) byType.set(neighbor.other.type, [...(byType.get(neighbor.other.type) ?? []), neighbor]);
  return byType;
}

class NeighborhoodBuilder {
  readonly nodes = new Map<string, Node>();
  readonly edges = new Map<string, Edge>();
  truncated = false;
  private readonly statuses: RelationStatus[];
  private readonly maxNodes: number;

  constructor(
    private readonly graph: GraphReader,
    private readonly options: NeighborhoodOptions,
  ) {
    this.statuses = options.statuses?.length ? [...options.statuses] : ['proposed', 'confirmed'];
    this.maxNodes = clamp(options.maxNodes ?? 60, { min: 5, max: 200 });
  }

  addNode(entity: GraphEntity, depth: number): void {
    if (!this.nodes.has(entity.id))
      this.nodes.set(entity.id, { id: entity.id, type: entity.type, name: entity.name, depth, count: null, status: entity.status ?? null });
  }

  /** Adds the neighbours of `from` at `depth`; returns those to expand in the next step. */
  expand(from: string, depth: number): string[] {
    const next: string[] = [];
    for (const [type, list] of groupByType(this.neighborsOf(from))) {
      const fresh = list.filter((neighbor) => !this.nodes.has(neighbor.other.id));
      if (fresh.length > HUB_GROUP) this.addGroup({ from, type, list, depth, size: fresh.length });
      else next.push(...this.addNeighbors(list, depth));
    }
    return next;
  }

  private neighborsOf(from: string): Neighbor[] {
    const { relationTypes, entityTypes } = this.options;
    const relations = this.graph
      .relationsOf(from, { statuses: [...this.statuses] })
      .filter((relation) => relation.relationType !== 'duplicate_of' && (!relationTypes?.length || relationTypes.includes(relation.relationType)));
    return relations.flatMap((relation) => {
      const otherId = otherEndOf(relation, from);
      const other = this.graph.getEntity(otherId);
      const shown = other && !other.duplicateOfId && (!entityTypes?.length || entityTypes.includes(other.type) || this.nodes.has(otherId));
      return shown ? [{ relation, other }] : [];
    });
  }

  /** A big hub: its new neighbours of one kind become one group node. */
  private addGroup(group: { from: string; type: EntityType; list: Neighbor[]; depth: number; size: number }): void {
    const id = `group:${group.from}:${group.type}`;
    this.nodes.set(id, { id, type: group.type, name: `${group.size} weitere`, depth: group.depth, count: group.size, status: null });
    const relationType = group.list[0]!.relation.relationType;
    this.edges.set(id, { id, source: group.from, target: id, relationType, status: 'confirmed', grouped: true });
    for (const neighbor of group.list.filter((x) => this.nodes.has(x.other.id))) this.edges.set(neighbor.relation.id, toEdge(neighbor.relation));
  }

  private addNeighbors(list: Neighbor[], depth: number): string[] {
    const next: string[] = [];
    for (const { relation, other } of list) {
      if (!this.nodes.has(other.id)) {
        if (this.nodes.size >= this.maxNodes) {
          this.truncated = true;
          continue;
        }
        this.addNode(other, depth);
        // the second step never runs through a big hub (a tag on every document says little)
        if (this.graph.relationsOf(other.id, { statuses: [...this.statuses] }).length <= HUB_GROUP * 4) next.push(other.id);
      }
      this.edges.set(relation.id, toEdge(relation));
    }
    return next;
  }
}

/** Nodes and relations up to `depth` (1–2) steps around `center`, readable with many nodes (#288). */
export function buildNeighborhood(graph: GraphReader, request: { center: GraphEntity; options: NeighborhoodOptions }): NeighborhoodGraph {
  const { center, options } = request;
  const depth = clamp(options.depth ?? 1, { min: 1, max: 2 });
  const builder = new NeighborhoodBuilder(graph, options);
  builder.addNode(center, 0);
  let frontier = [center.id];
  for (let step = 1; step <= depth; step += 1) frontier = frontier.flatMap((from) => builder.expand(from, step));
  return { centerId: center.id, nodes: [...builder.nodes.values()], edges: [...builder.edges.values()], truncated: builder.truncated };
}
