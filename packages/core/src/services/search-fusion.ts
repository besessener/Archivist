import { truncate } from '../util/text';
import type { ChunkMatch } from './search-keywords';
import type { VectorHit } from './vector-index';

/** An entity found by one or more passes, with its rank per pass. */
export interface Hit extends ChunkMatch {
  keywordRank?: number;
  /** Rank in the pass with a real embedding model (votes in the fusion). */
  vectorRank?: number;
  /** Rank in the local hash-vector pass: only fills in entities the other passes did not find. */
  localRank?: number;
  vectorScore?: number;
}

/** Reciprocal Rank Fusion constant. */
const K = 60;

/** Adds the hits of a vector pass: one rank per entity, so further chunks of the same entity do not push others down (#158). */
export function mergeVectorHits(hits: Map<string, Hit>, pass: { top: VectorHit[]; texts: Map<string, string>; local: boolean }): void {
  let rank = 0;
  const ranked = new Set<string>();
  for (const t of pass.top) {
    const text = pass.texts.get(t.chunkId);
    if (text === undefined || ranked.has(t.entityId)) continue;
    const existing = hits.get(t.entityId);
    // the local hash vectors are lexical, not semantic: they do not vote on what FTS found, they only add entities it missed
    if (pass.local && existing) continue;
    ranked.add(t.entityId);
    if (existing) {
      existing.vectorRank = Math.min(existing.vectorRank ?? rank, rank);
      existing.vectorScore = Math.max(existing.vectorScore ?? 0, t.score);
    } else {
      hits.set(t.entityId, {
        entityId: t.entityId,
        entityType: t.entityType,
        chunkText: text,
        snippet: truncate(text, 200),
        ...(pass.local ? { localRank: rank } : { vectorRank: rank }),
        vectorScore: t.score,
      });
    }
    rank += 1;
  }
}

/** The best `limit` hits by Reciprocal Rank Fusion; local-only hits rank after everything the voting passes found. */
export function fuse(hits: Map<string, Hit>, limit: number): Array<{ hit: Hit; score: number }> {
  const all = [...hits.values()];
  const voted = all.filter((h) => h.keywordRank !== undefined || h.vectorRank !== undefined).length;
  const scoreOf = (h: Hit) => {
    const score = (h.keywordRank !== undefined ? 1 / (K + h.keywordRank) : 0) + (h.vectorRank !== undefined ? 1 / (K + h.vectorRank) : 0);
    return score || (h.localRank !== undefined ? 1 / (K + voted + h.localRank) : 0);
  };
  return all
    .map((hit) => ({ hit, score: scoreOf(hit) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
