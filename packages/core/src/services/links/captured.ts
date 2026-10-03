import type { EntityType, GraphEntity, GraphRelation } from '@archivist/shared';
import type { CreatedEntry } from '../../util/origin-scope';
import { otherEndOf } from '../graph/rows';
import { relationTypeFor, type LinkCandidates } from './candidates';
import { LINK_PROPOSAL_METHODS, OWN_FLOW_TYPES, type LinkDeps } from './entries';

/** A link suggestion after capturing (#283): the stored proposal with both ends. */
export interface CapturedSuggestion {
  relation: GraphRelation;
  entry: { id: string; type: EntityType; name: string };
  target: { id: string; type: EntityType; name: string };
  score: number;
}

/** What the chat captures and offers links for (#283). */
const CAPTURED_TYPES: EntityType[] = ['note', 'decision', 'task', 'question', 'event'];

const endOf = (entity: GraphEntity) => ({ id: entity.id, type: entity.type, name: entity.name });

/** The best suggestions, at most `limit`, one per target and relation. */
function best(found: CapturedSuggestion[], limit: number): CapturedSuggestion[] {
  const out: CapturedSuggestion[] = [];
  for (const suggestion of found.toSorted((x, y) => y.score - x.score))
    if (out.length < limit && !out.some((o) => o.target.id === suggestion.target.id || o.relation.id === suggestion.relation.id)) out.push(suggestion);
  return out;
}

/** Link suggestions right after capturing in the chat (#283). */
export class CapturedSuggestions {
  constructor(
    private readonly deps: LinkDeps,
    private readonly candidates: LinkCandidates,
  ) {}

  /** For the new entries: their best candidates (#271) and open note-analysis proposals (#273), stored as proposals (#280). */
  async suggestForCaptured(entries: CreatedEntry[], options: { limit?: number } = {}): Promise<CapturedSuggestion[]> {
    const limit = options.limit ?? 3;
    const own = new Set(entries.map((entry) => entry.id));
    const found: CapturedSuggestion[] = [];
    for (const { id } of entries.filter((entry) => CAPTURED_TYPES.includes(entry.type)).slice(0, 5)) {
      const entry = this.deps.graph.getEntity(id);
      if (!entry) continue;
      found.push(...(await this.fromCandidates({ entry, own, limit })), ...this.openProposals({ entry, own }));
    }
    return best(found, limit);
  }

  private async fromCandidates(request: { entry: GraphEntity; own: Set<string>; limit: number }): Promise<CapturedSuggestion[]> {
    const { entry, own } = request;
    const found: CapturedSuggestion[] = [];
    for (const candidate of await this.candidates.candidates(entry.id, { limit: request.limit })) {
      if (own.has(candidate.id)) continue;
      const relation = this.deps.graph.link(
        { sourceId: entry.id, targetId: candidate.id, relationType: relationTypeFor(candidate) },
        {
          status: 'proposed',
          confidence: candidate.score,
          method: candidate.method,
          evidence: candidate.reason,
        },
      );
      if (relation?.status === 'proposed')
        found.push({ relation, entry: endOf(entry), target: { id: candidate.id, type: candidate.type, name: candidate.name }, score: candidate.score });
    }
    return found;
  }

  private openProposals(request: { entry: GraphEntity; own: Set<string> }): CapturedSuggestion[] {
    const { entry, own } = request;
    return this.deps.graph.relationsOf(entry.id, { statuses: ['proposed'] }).flatMap((relation) => {
      const otherId = otherEndOf(relation, entry.id);
      const other = this.deps.graph.getEntity(otherId);
      const reviewed = relation.method && LINK_PROPOSAL_METHODS.includes(relation.method) && !OWN_FLOW_TYPES.includes(relation.relationType);
      if (!other || own.has(otherId) || !reviewed) return [];
      return [{ relation, entry: endOf(entry), target: endOf(other), score: relation.confidence }];
    });
  }
}
