import type Database from 'better-sqlite3';
import type { EntityType } from '@archivist/shared';
import { searchStem, tokenize } from '../util/text';

/** The best chunk of an entity for a query. */
export interface ChunkMatch {
  entityId: string;
  entityType: string;
  chunkText: string;
  snippet: string;
}

/** A keyword query: the text, an optional type filter and how many entities to return. */
export interface KeywordQuery {
  query: string;
  types: readonly EntityType[] | null;
  limit: number;
}

/** Question and filler words that are no search terms (German and English). */
const QUERY_STOPWORDS = new Set(
  (
    'was wer wen wem wessen wann wo wohin woher wie warum weshalb wieso welche welcher welches welchen welchem ' +
    'gibt gab gibts es uns unser unsere unserem unseren unserer mir mich mein meine meinem meinen meiner dir dich dein deine ' +
    'zuletzt bitte mal zeig zeige zeigen sag sage sagen kannst koennen konnte gab haben hatten habe hast denn eigentlich genau etwas ' +
    'what who whom whose when where why how which did do does done we our us my me you your please show tell there any'
  ).split(' '),
);

/** Search terms of a query: question and filler words do not count (unless nothing else is left). */
function queryTerms(query: string): string[] {
  const tokens = [...new Set(tokenize(query))];
  const kept = tokens.filter((t) => !QUERY_STOPWORDS.has(t));
  // stemmed terms are matched as prefixes: inflected forms find each other (#162)
  return [...new Set((kept.length ? kept : tokens).map(searchStem))].slice(0, 12);
}

/** The index keeps ß while terms are folded to ss: a term with ss also matches its ß spelling (#161). */
function termMatch(term: string): string {
  const quoted = (t: string) => `"${t.replace(/"/g, '')}"*`;
  return term.includes('ss') ? `(${quoted(term)} OR ${quoted(term.replaceAll('ss', 'ß'))})` : quoted(term);
}

function ftsQuery(terms: string[], operator: 'AND' | 'OR'): string {
  return terms.map(termMatch).join(` ${operator} `);
}

/** One FTS MATCH expression per search term of the query (as a word prefix); empty without usable terms. */
export function termMatches(query: string): string[] {
  return queryTerms(query).map(termMatch);
}

/** How many distinct terms a chunk (with its title) contains, as word prefixes. */
export function termCoverage(terms: string[], text: string): number {
  const tokens = tokenize(text, { keepStopwords: true });
  return terms.filter((t) => tokens.some((token) => token.startsWith(t))).length;
}

/** Keyword pass (#158): AND and OR candidates ranked by distinct terms in the best chunk, then BM25 – plain OR-BM25 buried full matches. */
export function keywordPass(sqlite: Database.Database, spec: KeywordQuery): ChunkMatch[] {
  const terms = queryTerms(spec.query);
  if (terms.length === 0) return [];
  const candidates = new Map<string, ChunkMatch & { title: string; position: number }>();
  for (const operator of terms.length > 1 ? (['AND', 'OR'] as const) : (['OR'] as const)) {
    for (const hit of keywordHits(sqlite, { ...spec, query: ftsQuery(terms, operator) }))
      if (!candidates.has(hit.entityId)) candidates.set(hit.entityId, { ...hit, position: candidates.size });
  }
  return [...candidates.values()]
    .map((c) => ({ c, coverage: termCoverage(terms, `${c.title} ${c.chunkText}`) }))
    .sort((a, b) => b.coverage - a.coverage || a.c.position - b.c.position)
    .slice(0, spec.limit)
    .map(({ c }) => ({ entityId: c.entityId, entityType: c.entityType, chunkText: c.chunkText, snippet: c.snippet }));
}

/** Entities matching the FTS query (`spec.query`), best (BM25) chunk each, ordered by that chunk's score. */
function keywordHits(sqlite: Database.Database, spec: KeywordQuery): Array<ChunkMatch & { title: string }> {
  const typeClause = spec.types ? ` AND entity_type IN (${spec.types.map(() => '?').join(', ')})` : '';
  // bare columns next to min() come from the row with the minimum (SQLite) – i.e. the best chunk of the entity
  const best = sqlite
    .prepare(
      // MATERIALIZED: a flattened subquery would call bm25() outside the full-text query, which FTS5 rejects
      `WITH m AS MATERIALIZED (
           SELECT entity_id, entity_type, chunk_id, bm25(search_fts, 0, 0, 0, 3.0, 1.0) AS r
           FROM search_fts WHERE search_fts MATCH ?${typeClause})
         SELECT entity_id AS entityId, entity_type AS entityType, chunk_id AS chunkId, min(r) AS r
         FROM m GROUP BY entity_id ORDER BY r LIMIT ?`,
    )
    .all(spec.query, ...(spec.types ?? []), spec.limit) as Array<{ entityId: string; entityType: string; chunkId: string }>;
  if (best.length === 0) return [];
  const details = new Map(
    (
      sqlite
        .prepare(
          `SELECT chunk_id AS chunkId, title, content AS chunkText, snippet(search_fts, 4, '[', ']', '…', 14) AS snippet
             FROM search_fts WHERE search_fts MATCH ? AND chunk_id IN (${best.map(() => '?').join(', ')})`,
        )
        .all(spec.query, ...best.map((b) => b.chunkId)) as Array<{ chunkId: string; title: string; chunkText: string; snippet: string }>
    ).map((d) => [d.chunkId, d]),
  );
  return best.map((b) => ({
    entityId: b.entityId,
    entityType: b.entityType,
    title: details.get(b.chunkId)?.title ?? '',
    chunkText: details.get(b.chunkId)?.chunkText ?? '',
    snippet: details.get(b.chunkId)?.snippet ?? '',
  }));
}
