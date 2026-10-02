import type { EntityDetail, EntityType, GraphEntity, GraphRelation, RelationType } from '@archivist/shared';
import { AppError } from '../../util/errors';
import type { GraphEntities } from './entities';
import { buildNeighborhood, type GraphReader, type NeighborhoodGraph, type NeighborhoodOptions } from './neighborhood';
import { relationReason } from './relation-reason';
import type { GraphRelations } from './relations';
import { ACTIVE_STATUSES, otherEndOf } from './rows';

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

export interface RelatedQuery {
  depth?: number;
  limit?: number;
  types?: EntityType[];
}

const byClosenessAndStrength = (a: RelatedEntry, b: RelatedEntry) =>
  a.depth - b.depth || Number(b.relation.status === 'confirmed') - Number(a.relation.status === 'confirmed') || b.relation.confidence - a.relation.confidence;

/** Read-only views of an entry's surroundings: neighbours, related entries, detail and graph. */
export class GraphViews {
  constructor(
    private readonly entities: GraphEntities,
    private readonly relations: GraphRelations,
  ) {}

  neighbors(entityId: string, filter: { types?: EntityType[]; relationTypes?: RelationType[] }): GraphEntity[] {
    const found = this.entities.byIds(this.relations.activeNeighborIds(entityId, filter.relationTypes));
    return filter.types ? found.filter((entity) => filter.types!.includes(entity.type)) : found;
  }

  /** Neighbours up to `depth` (1 or 2) over current relations, each with its reason (#276, #289). */
  related(id: string, query: RelatedQuery): RelatedEntry[] {
    const depth = Math.min(Math.max(query.depth ?? 1, 1), 2);
    const found = new Map<string, RelatedEntry>();
    this.visit({ id, from: id, level: 1, via: null, found });
    if (depth === 2)
      for (const first of [...found.values()]) {
        // hubs (topics with hundreds of documents) are not expanded – they say little about a single entry
        if (first.entity.type === 'category' || first.entity.type === 'tag') continue;
        this.visit({ id, from: first.entity.id, level: 2, via: first.entity, found });
      }
    return [...found.values()]
      .filter((entry) => !query.types || query.types.includes(entry.entity.type))
      .toSorted(byClosenessAndStrength)
      .slice(0, query.limit ?? 100);
  }

  private visit(step: { id: string; from: string; level: number; via: GraphEntity | null; found: Map<string, RelatedEntry> }): void {
    for (const relation of this.relations.of(step.from, { statuses: ACTIVE_STATUSES })) {
      const otherId = otherEndOf(relation, step.from);
      if (otherId === step.id || step.found.has(otherId)) continue;
      const other = this.entities.get(otherId);
      if (!other || other.duplicateOfId) continue;
      step.found.set(otherId, { entity: other, depth: step.level, relation, reason: relationReason(relation), via: step.via });
    }
  }

  rejectedPairsOf(id: string): Array<{ relation: GraphRelation; other: GraphEntity }> {
    return this.relations.of(id, { statuses: ['rejected'] }).flatMap((relation) => {
      const other = this.entities.get(otherEndOf(relation, id));
      return other ? [{ relation, other }] : [];
    });
  }

  detail(id: string): EntityDetail {
    const entity = this.entities.get(id);
    if (!entity) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    // outdated relations are history only: the detail view shows current assignments (and user rejections)
    const current = this.relations.of(id, {}).filter((relation) => relation.status !== 'outdated');
    const otherIds = [...new Set(current.map((relation) => otherEndOf(relation, id)))];
    const others = new Map(this.entities.byIds(otherIds).map((other) => [other.id, other]));
    return {
      entity,
      relations: current.flatMap((relation) => {
        const outgoing = relation.sourceEntityId === id;
        const other = others.get(otherEndOf(relation, id));
        return other ? [{ ...relation, direction: outgoing ? ('out' as const) : ('in' as const), other }] : [];
      }),
    };
  }

  neighborhood(id: string, options: NeighborhoodOptions): NeighborhoodGraph {
    const center = this.entities.get(id);
    if (!center) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    const reader: GraphReader = {
      getEntity: (entityId) => this.entities.get(entityId),
      relationsOf: (entityId, filter) => this.relations.of(entityId, filter),
    };
    return buildNeighborhood(reader, { center, options });
  }
}
