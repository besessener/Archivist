import type { GraphEntity } from '@archivist/shared';
import { normalizeName, truncate } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { GatheredSource, SourceReader } from './knowledge-sources';
import type { SearchHit, SearchService } from './search';

/** Sources per answer from the search hits; supporting documents, cases and linked entries come on top. */
const SOURCE_LIMIT = 10;
/** Sources that come in over confirmed relations of the best hits (#289). */
const MAX_LINKED_SOURCES = 3;
const LINKED_PER_HIT = 2;
const ENTRIES_PER_CASE = 6;
const LINKED_SOURCE_TYPES = new Set<string>(['document', 'decision', 'event', 'task', 'note']);
/** The relation in words, from the hit's point of view („stützt“, „ersetzt“ …). */
const RELATION_LABEL_DE: Partial<Record<string, string>> = {
  supports: 'stützt',
  contradicts: 'widerspricht',
  supersedes: 'ersetzt',
  blocks: 'blockiert',
  results_from: 'folgt aus',
  related_to: 'verwandt mit',
  subtopic_of: 'Unterthema von',
  relates_to: 'bezieht sich auf',
  belongs_to: 'gehört zu',
  concerns: 'betrifft',
  affects: 'wirkt sich aus auf',
};

/** Where to look for entries related to a source: ids already taken, the query for the passage, the score they get. */
interface RelatedSpec {
  taken: Set<string>;
  query: string;
  score: number;
}

/** Gathers the sources of a knowledge answer: search hits of several wordings, then cases and confirmed links of the best hits. */
export class SourceGatherer {
  constructor(
    private readonly deps: { search: SearchService; graph: KnowledgeGraphService },
    private readonly reader: SourceReader,
  ) {}

  async gather(queries: string[]): Promise<GatheredSource[]> {
    const hits = await this.fusedHits(queries);
    const out: GatheredSource[] = [];
    const supporting: GatheredSource[] = [];
    for (const hit of hits) {
      if (out.length >= SOURCE_LIMIT) break;
      const source = this.reader.sourceOf(hit, supporting);
      if (source) out.push(source);
    }
    // up to 3 supporting documents of retrieved decisions, after the hits
    const ids = new Set(out.map((o) => o.id));
    const support = supporting.filter((b, i) => !ids.has(b.id) && supporting.findIndex((x) => x.id === b.id) === i).slice(0, 3);
    for (const b of support) ids.add(b.id);
    // a case the question names (#286): its entries count as sources, with the case as the path
    const cases = this.caseSources(queries, { taken: ids, query: queries[0] ?? '', score: out[0]?.score ?? 0.02 });
    // entries the user linked with the best hits (#289): confirmed relations only, weighted lower, with the path
    return [...out, ...support, ...cases, ...this.linkedSources(out.slice(0, 3), { taken: ids, query: queries[0] ?? '' })];
  }

  /** Each wording is searched and the hits are merged by reciprocal rank (#164), so a miss of one wording is not final. */
  private async fusedHits(queries: string[]): Promise<SearchHit[]> {
    const fused = new Map<string, { hit: SearchHit; score: number }>();
    for (const query of queries) {
      const found = await this.deps.search.search(query, { limit: SOURCE_LIMIT * 2, types: ['document', 'decision', 'event', 'task', 'note'] });
      found.forEach((hit, rank) => {
        const current = fused.get(hit.id);
        const add = 1 / (60 + rank);
        if (current) current.score += add;
        else fused.set(hit.id, { hit, score: add });
      });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score).map((f) => f.hit);
  }

  /** Entries of up to two cases („Vorgänge“) the question names by name or alias (#286), over confirmed assignments only. */
  private caseSources(queries: string[], spec: RelatedSpec): GatheredSource[] {
    const text = ` ${normalizeName(queries.join(' '))} `;
    return this.deps.graph
      .listEntities({ type: 'case', limit: 500 })
      .filter((c) => [c.name, ...c.aliases].some((n) => normalizeName(n).length >= 3 && text.includes(` ${normalizeName(n)} `)))
      .slice(0, 2)
      .flatMap((c) => this.caseEntries(c, spec));
  }

  private caseEntries(subject: GraphEntity, spec: RelatedSpec): GatheredSource[] {
    const found: GatheredSource[] = [];
    for (const r of this.deps.graph.relationsOf(subject.id, { statuses: ['confirmed'] })) {
      if (found.length >= ENTRIES_PER_CASE) break;
      const otherId = r.sourceEntityId === subject.id ? r.targetEntityId : r.sourceEntityId;
      const source = this.relatedSource(otherId, spec);
      if (!source) continue;
      const via = `Teil des Vorgangs „${subject.name}“`;
      found.push({ ...source, via, _text: `${source._text}\n(${via})` });
      spec.taken.add(otherId);
    }
    return found;
  }

  /** Confirmed relations of the best hits (#289): at most 2 per hit and 3 in all, half the hit's score, each saying how it came in. */
  private linkedSources(top: GatheredSource[], spec: Omit<RelatedSpec, 'score'>): GatheredSource[] {
    const out: GatheredSource[] = [];
    for (const parent of top) out.push(...this.linkedOf(parent, { ...spec, limit: Math.min(LINKED_PER_HIT, MAX_LINKED_SOURCES - out.length) }));
    return out;
  }

  private linkedOf(parent: GatheredSource, spec: Omit<RelatedSpec, 'score'> & { limit: number }): GatheredSource[] {
    const found: GatheredSource[] = [];
    for (const r of this.deps.graph.relationsOf(parent.id, { statuses: ['confirmed'] })) {
      if (found.length >= spec.limit) break;
      if (r.relationType === 'duplicate_of') continue;
      const otherId = r.sourceEntityId === parent.id ? r.targetEntityId : r.sourceEntityId;
      const source = this.relatedSource(otherId, { ...spec, score: parent.score / 2 });
      if (!source) continue;
      const label = RELATION_LABEL_DE[r.relationType] ?? r.relationType;
      const via = r.sourceEntityId === parent.id ? `„${parent.title}“ ${label} diesen Eintrag` : `${label} „${parent.title}“`;
      found.push({ ...source, via, _text: `${source._text}\n(Hinzugekommen über die bestätigte Verknüpfung: ${via})` });
      spec.taken.add(otherId);
    }
    return found;
  }

  /** Another entry as a source, with its best passage; null when taken, a duplicate or of a type that is no source. */
  private relatedSource(otherId: string, spec: RelatedSpec): GatheredSource | null {
    const other = this.deps.graph.getEntity(otherId);
    if (!other || spec.taken.has(otherId) || other.duplicateOfId || !LINKED_SOURCE_TYPES.has(other.type)) return null;
    const passage = this.deps.search.bestPassage(otherId, spec.query) ?? other.description ?? other.name;
    return this.reader.sourceOf(
      {
        id: other.id,
        type: other.type,
        title: other.name,
        snippet: truncate(passage, 220),
        passage,
        score: spec.score,
        path: null,
        date: other.updatedAt,
        matchedBy: [],
      },
      [],
    );
  }
}
