import type { EntityType, RelationType } from '@archivist/shared';
import { normalizeName, truncate } from '../../util/text';
import { otherEndOf, type RelationKey } from '../graph/rows';
import { isConnected, isEntry, LINK_ENTRY_TYPES, type LinkDeps } from './entries';

/** Minimum cosine similarity for a proposal (#271); the lexical local vectors are noisier than embeddings, so their bar is higher. */
export const MIN_SIMILARITY = { local: 0.5, embeddings: 0.45 };

/** Default of the most open similarity proposals per entry (setting `links.maxProposalsPerEntry`). */
export const MAX_SIMILAR_PROPOSALS = 3;

export interface LinkCandidate {
  id: string;
  type: EntityType;
  name: string;
  /** 0..1 */
  score: number;
  method: 'similarity' | 'mention';
  /** Why: the matching passage or the mentioned name. */
  reason: string;
}

/** The relation a candidate is proposed with: similar entries are related, a mentioned project or topic is the entry's. */
export const relationTypeFor = (candidate: LinkCandidate): RelationType =>
  candidate.method === 'similarity' ? 'related_to' : candidate.type === 'project' ? 'belongs_to' : 'relates_to';

/** Creates one similarity proposal; returns whether it is new. */
export type SimilarProposer = (key: RelationKey, proposal: { confidence: number; evidence: string }) => boolean;

export interface SimilarQuery {
  id: string;
  types: EntityType[];
  limit: number;
  /** The threshold includes what the user's rejections taught (#275): for link proposals, not for grouping into a topic. */
  learned: boolean;
}

/** Link candidates of an entry (#271, #283) and the proposals made from them. */
export class LinkCandidates {
  constructor(private readonly deps: LinkDeps) {}

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  /** Name and description of an entry, as the text its name suggestions and mentions are taken from. */
  entryText(id: string): string {
    const entity = this.deps.graph.getEntity(id);
    return entity ? `${entity.name} ${entity.description ?? ''}`.trim() : '';
  }

  /** Similar indexed entries by their vectors (best first), without the entry itself. */
  similar(query: SimilarQuery) {
    const raise = query.learned ? (this.deps.thresholds?.offset('similarity') ?? 0) : 0;
    const minScore = { local: MIN_SIMILARITY.local + raise, embeddings: MIN_SIMILARITY.embeddings + raise };
    return this.deps.search.similarTo(query.id, { types: query.types, limit: query.limit, minScore });
  }

  /** Similar entries and mentioned topics/projects, without the entry itself, linked or rejected pairs and non-entries. */
  async candidates(entityId: string, options: { limit?: number; types?: EntityType[] } = {}): Promise<LinkCandidate[]> {
    const limit = options.limit ?? 3;
    if (!this.deps.graph.getEntity(entityId)) return [];
    const found = new Map<string, LinkCandidate>();
    for (const hit of await this.similar({ id: entityId, types: options.types ?? LINK_ENTRY_TYPES, limit: limit * 4, learned: true })) {
      if (found.has(hit.id) || isConnected(this.sqlite, { a: entityId, b: hit.id }) || !isEntry(this.sqlite, hit.id)) continue;
      const entity = this.deps.graph.getEntity(hit.id);
      if (!entity) continue;
      const reason = truncate(hit.passage.replace(/\s+/g, ' '), 200);
      found.set(hit.id, { id: hit.id, type: entity.type, name: entity.name, score: hit.score, method: 'similarity', reason });
    }
    for (const mention of this.mentions(entityId)) found.set(mention.id, mention);
    return [...found.values()].toSorted((a, b) => b.score - a.score).slice(0, limit);
  }

  /** „Das klingt nach Projekt X“: known topics and projects the entry names. */
  private mentions(entityId: string): LinkCandidate[] {
    const words = ` ${normalizeName(this.entryText(entityId))} `;
    const out: LinkCandidate[] = [];
    for (const type of ['project', 'topic'] as const)
      for (const subject of this.deps.graph.listEntities({ type, limit: 500, confirmedOnly: true })) {
        const name = normalizeName(subject.name);
        if (subject.id === entityId || name.length < 3 || !words.includes(` ${name} `) || isConnected(this.sqlite, { a: entityId, b: subject.id })) continue;
        const reason = `nennt ${type === 'project' ? 'das Projekt' : 'das Thema'} „${subject.name}“`;
        out.push({ id: subject.id, type, name: subject.name, score: 0.9, method: 'mention', reason });
      }
    return out;
  }

  /** Open similarity proposals of an entry (either direction). */
  private openSimilarityProposals(id: string): number {
    return (
      this.sqlite
        .prepare(`SELECT count(*) AS c FROM relations WHERE (source_entity_id = ? OR target_entity_id = ?) AND status = 'proposed' AND method = 'similarity'`)
        .get(id, id) as { c: number }
    ).c;
  }

  /** Proposes similar entries as `related_to` (#271), at most `max` open ones per entry on both ends; returns the number new. */
  async proposeSimilar(id: string, options: { max?: number; propose?: SimilarProposer } = {}): Promise<number> {
    const max = options.max ?? MAX_SIMILAR_PROPOSALS;
    const propose = options.propose ?? this.proposeLink;
    if (!isEntry(this.sqlite, id)) return 0;
    let room = max - this.openSimilarityProposals(id);
    if (room <= 0) return 0;
    let created = 0;
    for (const candidate of await this.candidates(id, { limit: max * 2 })) {
      if (room <= 0) break;
      if (candidate.method !== 'similarity' || this.openSimilarityProposals(candidate.id) >= max) continue;
      if (propose({ sourceId: id, targetId: candidate.id, relationType: 'related_to' }, { confidence: candidate.score, evidence: candidate.reason })) {
        created += 1;
        room -= 1;
      }
    }
    return created;
  }

  private readonly proposeLink: SimilarProposer = (key, proposal) =>
    this.deps.graph.link(key, { status: 'proposed', method: 'similarity', ...proposal })?.created ?? false;

  /** Proposes the open cases of confirmed members similar to the entry (#286); returns the number new. */
  async proposeCases(id: string): Promise<number> {
    if (!isEntry(this.sqlite, id)) return 0;
    let created = 0;
    for (const [caseId, best] of await this.similarCases(id)) {
      if (isConnected(this.sqlite, { a: id, b: caseId })) continue;
      const found = this.deps.graph.getEntity(caseId)!;
      const result = this.deps.graph.link(
        { sourceId: id, targetId: caseId, relationType: 'belongs_to' },
        {
          status: 'proposed',
          confidence: best.score,
          method: 'similarity',
          evidence: `ähnlich wie „${truncate(best.via, 80)}“ aus dem Vorgang „${truncate(found.name, 60)}“`,
        },
      );
      if (result?.created) created += 1;
    }
    return created;
  }

  /** Per open case the best similar confirmed member of it. */
  private async similarCases(id: string): Promise<Map<string, { score: number; via: string }>> {
    const best = new Map<string, { score: number; via: string }>();
    for (const hit of await this.similar({ id, types: LINK_ENTRY_TYPES, limit: 8, learned: true })) {
      for (const relation of this.deps.graph.relationsOf(hit.id, { statuses: ['confirmed'], types: ['belongs_to'] })) {
        const caseId = otherEndOf(relation, hit.id);
        const found = this.deps.graph.getEntity(caseId);
        if (found?.type !== 'case' || found.status === 'closed' || (best.get(caseId)?.score ?? 0) >= hit.score) continue;
        best.set(caseId, { score: hit.score, via: this.deps.graph.getEntity(hit.id)?.name ?? '' });
      }
    }
    return best;
  }
}
