import type { EntityType, SearchResult } from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { chunks, decisions, documents, entities } from '../db/schema';
import { newId } from '../util/ids';
import { chunkText, normalizeName, searchStem, tokenize, truncate } from '../util/text';
import type { WorkerPool } from '../workers/pool';
import type { EmbeddingService, EmbedResult } from './embedding';
import { LOCAL_MODEL } from './embedding';
import { VectorIndex } from './vector-index';

export interface IndexInput {
  type: EntityType;
  id: string;
  title: string;
  content: string;
  /** false: create vectors locally only */
  allowRemoteEmbedding?: boolean;
}

/** Search result plus the matched chunk text (main process only; not part of the IPC result). */
export interface SearchHit extends SearchResult {
  /** The best matching chunk of the entity – the passage an answer should be based on (#157). */
  passage: string;
}

interface Hit {
  entityId: string;
  entityType: string;
  chunkText: string;
  snippet: string;
  keywordRank?: number;
  /** Rank in the pass with a real embedding model (votes in the fusion). */
  vectorRank?: number;
  /** Rank in the local hash-vector pass: only fills in entities the other passes did not find. */
  localRank?: number;
  vectorScore?: number;
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

/** Minimum number of entities the keyword pass returns (more when the caller asks for more results). */
const FTS_ENTITY_LIMIT = 60;

/** How long a search waits for the remote query embedding before it answers with local results only. */
const REMOTE_QUERY_EMBEDDING_TIMEOUT_MS = 2500;

/** Hybrid search: FTS5 (BM25) + vector similarity (cosine, computed in the worker thread), fused via RRF. */
export class SearchService {
  private readonly vectors: VectorIndex;

  constructor(
    private readonly ctx: AppContext,
    private readonly embedding: EmbeddingService,
    pool: WorkerPool,
    private readonly remoteAllowed: () => boolean = () => false,
    private readonly remoteQueryTimeoutMs = REMOTE_QUERY_EMBEDDING_TIMEOUT_MS,
  ) {
    this.vectors = new VectorIndex(() => this.ctx.database.sqlite, pool);
  }

  /** Embeds the query; a remote request that does not answer in time is ignored (null). */
  private async embedQuery(query: string, useRemote: boolean): Promise<EmbedResult | null> {
    const pending = this.embedding.embed([query], { allowRemote: useRemote, purpose: 'Suchanfrage' });
    if (!useRemote) return pending;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.remoteQueryTimeoutMs);
    });
    try {
      const res = await Promise.race([pending.catch(() => null), timeout]);
      if (!res) this.ctx.logger.warn('search', 'Embedding endpoint did not answer in time – local hits only', { timeoutMs: this.remoteQueryTimeoutMs });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  remove(entityId: string): void {
    this.deleteRows(entityId);
    this.vectors.remove(entityId);
  }

  /**
   * FTS rows share the rowid of their chunk (migration 0016), so they are deleted by rowid via the indexed chunks
   * table. `WHERE entity_id = ?` on the UNINDEXED FTS column scanned the whole index on every call (#212).
   */
  private deleteRows(entityId: string): void {
    this.sqlite.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE entity_id = ?)').run(entityId);
    this.ctx.database.db.delete(chunks).where(eq(chunks.entityId, entityId)).run();
  }

  async index(input: IndexInput): Promise<number> {
    const parts = chunkText(input.content);
    if (parts.length === 0) parts.push(input.title);
    const emb = await this.embedding.embed(
      parts.map((p) => `${input.title}\n${p}`),
      { allowRemote: input.allowRemoteEmbedding ?? false, purpose: 'Suchindex', documentIds: input.type === 'document' ? [input.id] : [] },
    );
    const db = this.ctx.database;
    const written: Array<{ id: string; vector: Float32Array | undefined }> = [];
    db.transaction(() => {
      this.deleteRows(input.id);
      const insertFts = this.sqlite.prepare('INSERT INTO search_fts (rowid, chunk_id, entity_id, entity_type, title, content) VALUES (?, ?, ?, ?, ?, ?)');
      parts.forEach((text, idx) => {
        const chunkId = newId();
        const vec = emb.vectors[idx];
        written.push({ id: chunkId, vector: vec });
        const { lastInsertRowid } = db.db
          .insert(chunks)
          .values({
            id: chunkId,
            entityType: input.type,
            entityId: input.id,
            idx,
            text,
            embedding: vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null,
            embeddingModel: emb.model,
          })
          .run();
        insertFts.run(lastInsertRowid, chunkId, input.id, input.type, input.title, text);
      });
    });
    // only after the commit: a rolled-back transaction must not leave vectors in the index
    this.vectors.replace(input.id, input.type, emb.model, written);
    return parts.length;
  }

  /** Search terms of a query: question and filler words do not count (unless nothing else is left). */
  private queryTerms(query: string): string[] {
    const toks = [...new Set(tokenize(query))];
    const kept = toks.filter((t) => !QUERY_STOPWORDS.has(t));
    // stemmed terms are matched as prefixes: inflected forms find each other (#162)
    return [...new Set((kept.length ? kept : toks).map(searchStem))].slice(0, 12);
  }

  private ftsQuery(terms: string[], op: 'AND' | 'OR'): string | null {
    if (terms.length === 0) return null;
    return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(` ${op} `);
  }

  /**
   * Keyword pass: candidates from an AND query (all terms) and an OR query, ordered by how many distinct
   * terms the entity's best chunk (with title) contains, then by BM25 (#158). Plain OR-BM25 let short
   * documents dense in one term bury the document that contains all of them.
   */
  private keywordPass(query: string, types: readonly EntityType[] | null, limit: number): Array<Omit<Hit, 'keywordRank'>> {
    const terms = this.queryTerms(query);
    const candidates = new Map<string, Omit<Hit, 'keywordRank'> & { title: string; pos: number }>();
    for (const op of terms.length > 1 ? (['AND', 'OR'] as const) : (['OR'] as const)) {
      const fts = this.ftsQuery(terms, op);
      if (!fts) continue;
      for (const h of this.keywordHits(fts, types, limit)) if (!candidates.has(h.entityId)) candidates.set(h.entityId, { ...h, pos: candidates.size });
    }
    const coverage = (title: string, text: string) => {
      const toks = tokenize(`${title} ${text}`, { keepStopwords: true });
      return terms.filter((t) => toks.some((tok) => tok.startsWith(t))).length;
    };
    return [...candidates.values()]
      .map((c) => ({ c, cov: coverage(c.title, c.chunkText) }))
      .sort((a, b) => b.cov - a.cov || a.c.pos - b.c.pos)
      .slice(0, limit)
      .map(({ c }) => ({ entityId: c.entityId, entityType: c.entityType, chunkText: c.chunkText, snippet: c.snippet }));
  }

  /** Entities matching the FTS query, best (BM25) chunk each, ordered by that chunk's score. */
  private keywordHits(fts: string, types: readonly EntityType[] | null, limit: number): Array<Omit<Hit, 'keywordRank'> & { title: string }> {
    const typeClause = types ? ` AND entity_type IN (${types.map(() => '?').join(', ')})` : '';
    // bare columns next to min() come from the row with the minimum (SQLite) – i.e. the best chunk of the entity
    const best = this.sqlite
      .prepare(
        // MATERIALIZED: a flattened subquery would call bm25() outside the full-text query, which FTS5 rejects
        `WITH m AS MATERIALIZED (
           SELECT entity_id, entity_type, chunk_id, bm25(search_fts, 0, 0, 0, 3.0, 1.0) AS r
           FROM search_fts WHERE search_fts MATCH ?${typeClause})
         SELECT entity_id AS entityId, entity_type AS entityType, chunk_id AS chunkId, min(r) AS r
         FROM m GROUP BY entity_id ORDER BY r LIMIT ?`,
      )
      .all(fts, ...(types ?? []), limit) as Array<{ entityId: string; entityType: string; chunkId: string }>;
    if (best.length === 0) return [];
    const details = new Map(
      (
        this.sqlite
          .prepare(
            `SELECT chunk_id AS chunkId, title, content AS chunkText, snippet(search_fts, 4, '[', ']', '…', 14) AS snippet
             FROM search_fts WHERE search_fts MATCH ? AND chunk_id IN (${best.map(() => '?').join(', ')})`,
          )
          .all(fts, ...best.map((b) => b.chunkId)) as Array<{ chunkId: string; title: string; chunkText: string; snippet: string }>
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

  async search(query: string, opts: { types?: EntityType[]; limit?: number; allowRemoteEmbedding?: boolean } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 30;
    const hits = new Map<string, Hit>();

    // 1) keyword search: best chunk per entity, type filter inside the query – the LIMIT counts entities, not chunks (#159)
    try {
      for (const [rank, r] of this.keywordPass(query, opts.types ?? null, Math.max(FTS_ENTITY_LIMIT, limit * 2)).entries())
        hits.set(r.entityId, { ...r, keywordRank: rank });
    } catch (err) {
      this.ctx.logger.warn('search', 'FTS query failed', { error: err });
    }

    // 2) semantic search (local vectors and – if allowed – the endpoint's embedding model)
    const wantRemote = opts.allowRemoteEmbedding ?? this.remoteAllowed();
    for (const useRemote of [false, true]) {
      if (useRemote && !wantRemote) continue;
      const q = await this.embedQuery(query, useRemote);
      if (!q || (useRemote && q.model === LOCAL_MODEL)) continue;
      const qvec = q.vectors[0];
      if (!qvec) continue;
      const top = await this.vectors.search(q.model, qvec, { k: 40, minScore: q.model === LOCAL_MODEL ? 0.22 : 0.3, types: opts.types ?? null });
      if (top.length === 0) continue;
      // texts only for the hits, not for the whole corpus
      const texts = new Map(
        this.ctx.database.db
          .select({ id: chunks.id, text: chunks.text })
          .from(chunks)
          .where(
            inArray(
              chunks.id,
              top.map((t) => t.chunkId),
            ),
          )
          .all()
          .map((c) => [c.id, c.text]),
      );
      // rank per entity and per pass: further chunks of the same entity do not push other entities down (#158)
      // The local hash vectors are lexical, not semantic: they do not vote on what FTS found, they only add entities it missed.
      const local = q.model === LOCAL_MODEL;
      let rank = 0;
      const ranked = new Set<string>();
      for (const t of top) {
        const text = texts.get(t.chunkId);
        if (text === undefined || ranked.has(t.entityId)) continue;
        const existing = hits.get(t.entityId);
        if (local && existing) continue;
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
            ...(local ? { localRank: rank } : { vectorRank: rank }),
            vectorScore: t.score,
          });
        }
        rank += 1;
      }
    }

    // 3) fusion (Reciprocal Rank Fusion) and enrichment
    const K = 60;
    const voted = [...hits.values()].filter((h) => h.keywordRank !== undefined || h.vectorRank !== undefined).length;
    const fuse = (h: Hit) => {
      const score = (h.keywordRank !== undefined ? 1 / (K + h.keywordRank) : 0) + (h.vectorRank !== undefined ? 1 / (K + h.vectorRank) : 0);
      // local-only hits rank after everything the voting passes found
      return score || (h.localRank !== undefined ? 1 / (K + voted + h.localRank) : 0);
    };
    const scored = [...hits.values()]
      .map((h) => ({ h, score: fuse(h) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (scored.length === 0) return [];
    const ids = scored.map((s) => s.h.entityId);
    const ents = new Map(
      this.ctx.database.db
        .select()
        .from(entities)
        .where(inArray(entities.id, ids))
        .all()
        .map((e) => [e.id, e]),
    );
    const docs = new Map(
      this.ctx.database.db
        .select({
          id: documents.id,
          rel: documents.archiveRelPath,
          src: documents.sourcePath,
          at: documents.archivedAt,
          created: documents.createdAt,
          status: documents.status,
        })
        .from(documents)
        .where(inArray(documents.id, ids))
        .all()
        .map((d) => [d.id, d]),
    );
    const decs = new Map(
      this.ctx.database.db
        .select({ id: decisions.id, at: decisions.decidedAt })
        .from(decisions)
        .where(inArray(decisions.id, ids))
        .all()
        .map((d) => [d.id, d]),
    );
    const max = scored[0]?.score || 1;
    return scored.flatMap(({ h, score }) => {
      const ent = ents.get(h.entityId);
      if (!ent) return [];
      const d = docs.get(h.entityId);
      return [
        {
          type: h.entityType as EntityType,
          id: h.entityId,
          title: ent.name,
          snippet: h.snippet || truncate(h.chunkText, 200),
          score: Math.round((score / max) * 1000) / 1000,
          path: d?.rel ?? d?.src ?? null,
          date: d ? (d.at ?? d.created) : (decs.get(h.entityId)?.at ?? ent.updatedAt),
          passage: h.chunkText,
          matchedBy: [
            ...(h.keywordRank !== undefined ? (['keyword'] as const) : []),
            ...(h.vectorRank !== undefined || h.localRank !== undefined ? (['semantic'] as const) : []),
          ],
        },
      ];
    });
  }

  /** The indexed chunk of an entity that shares the most terms with `text` (e.g. a decision's source passage). */
  bestPassage(entityId: string, text: string): string | null {
    const rows = this.ctx.database.db.select({ text: chunks.text }).from(chunks).where(eq(chunks.entityId, entityId)).orderBy(chunks.idx).all();
    if (rows.length === 0) return null;
    const terms = [...new Set(tokenize(text).map(searchStem))];
    const score = (chunk: string) => {
      const toks = tokenize(chunk, { keepStopwords: true });
      return terms.filter((t) => toks.some((tok) => tok.startsWith(t))).length;
    };
    let best = rows[0]!.text;
    let bestScore = -1;
    for (const r of rows) {
      const sc = score(r.text);
      if (sc > bestScore) {
        best = r.text;
        bestScore = sc;
      }
    }
    return best;
  }

  /**
   * Entries similar to an indexed entry (#271): raw cosine similarity of their chunk vectors – of the endpoint's embedding
   * model when the entry has such vectors, otherwise of the local (lexical) hash vectors; `local` tells which, so callers
   * can apply a higher bar to the latter. With the best matching passage of the other entry as evidence.
   */
  async similarTo(
    entityId: string,
    opts: { types: readonly EntityType[]; limit: number; minScore: { local: number; embeddings: number } },
  ): Promise<Array<{ id: string; type: EntityType; score: number; passage: string; local: boolean }>> {
    const models = (
      this.sqlite.prepare('SELECT DISTINCT embedding_model AS m FROM chunks WHERE entity_id = ? AND embedding IS NOT NULL').all(entityId) as Array<{
        m: string;
      }>
    ).map((r) => r.m);
    const model = models.find((m) => m !== LOCAL_MODEL) ?? models.find((m) => m === LOCAL_MODEL);
    if (!model) return [];
    const local = model === LOCAL_MODEL;
    const hits = await this.vectors.similarTo(model, entityId, {
      k: opts.limit,
      minScore: local ? opts.minScore.local : opts.minScore.embeddings,
      types: opts.types,
    });
    const passage = this.sqlite.prepare('SELECT text FROM chunks WHERE id = ?');
    return hits.map((h) => ({
      id: h.entityId,
      type: h.entityType as EntityType,
      score: Math.round(h.score * 1000) / 1000,
      passage: (passage.get(h.chunkId) as { text: string } | undefined)?.text ?? '',
      local,
    }));
  }

  /** Documents whose content is close to a name/topic (for assignment proposals). */
  async similarEntities(text: string, types: EntityType[], limit = 10): Promise<SearchHit[]> {
    const q = normalizeName(text).split(' ').slice(0, 60).join(' ');
    return q ? this.search(q, { types, limit }) : [];
  }
}
