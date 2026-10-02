import type { EntityType, SearchResult } from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { chunks, decisions, documents, entities } from '../db/schema';
import { newId } from '../util/ids';
import { chunkText, normalizeName, tokenize, truncate } from '../util/text';
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
  vectorRank?: number;
  vectorScore?: number;
}

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

  private deleteRows(entityId: string): void {
    this.sqlite.prepare('DELETE FROM search_fts WHERE entity_id = ?').run(entityId);
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
      const insertFts = this.sqlite.prepare('INSERT INTO search_fts (chunk_id, entity_id, entity_type, title, content) VALUES (?, ?, ?, ?, ?)');
      parts.forEach((text, idx) => {
        const chunkId = newId();
        const vec = emb.vectors[idx];
        written.push({ id: chunkId, vector: vec });
        db.db
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
        insertFts.run(chunkId, input.id, input.type, input.title, text);
      });
    });
    // only after the commit: a rolled-back transaction must not leave vectors in the index
    this.vectors.replace(input.id, input.type, emb.model, written);
    return parts.length;
  }

  private ftsQuery(query: string): string | null {
    const toks = tokenize(query).slice(0, 12);
    if (toks.length === 0) return null;
    return toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  }

  /** Entities matching the FTS query, best (BM25) chunk each, ordered by that chunk's score. */
  private keywordHits(fts: string, types: readonly EntityType[] | null, limit: number): Array<Omit<Hit, 'keywordRank'>> {
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
            `SELECT chunk_id AS chunkId, content AS chunkText, snippet(search_fts, 4, '[', ']', '…', 14) AS snippet
             FROM search_fts WHERE search_fts MATCH ? AND chunk_id IN (${best.map(() => '?').join(', ')})`,
          )
          .all(fts, ...best.map((b) => b.chunkId)) as Array<{ chunkId: string; chunkText: string; snippet: string }>
      ).map((d) => [d.chunkId, d]),
    );
    return best.map((b) => ({
      entityId: b.entityId,
      entityType: b.entityType,
      chunkText: details.get(b.chunkId)?.chunkText ?? '',
      snippet: details.get(b.chunkId)?.snippet ?? '',
    }));
  }

  async search(query: string, opts: { types?: EntityType[]; limit?: number; allowRemoteEmbedding?: boolean } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 30;
    const hits = new Map<string, Hit>();

    // 1) keyword search: best chunk per entity, type filter inside the query – the LIMIT counts entities, not chunks (#159)
    const fts = this.ftsQuery(query);
    if (fts) {
      try {
        for (const [rank, r] of this.keywordHits(fts, opts.types ?? null, Math.max(FTS_ENTITY_LIMIT, limit * 2)).entries())
          hits.set(r.entityId, { ...r, keywordRank: rank });
      } catch (err) {
        this.ctx.logger.warn('search', 'FTS query failed', { error: err });
      }
    }

    // 2) semantic search (local vectors and – if allowed – the endpoint's embedding model)
    const wantRemote = opts.allowRemoteEmbedding ?? this.remoteAllowed();
    let rank = 0;
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
      for (const t of top) {
        const text = texts.get(t.chunkId);
        if (text === undefined) continue;
        const existing = hits.get(t.entityId);
        if (existing) {
          existing.vectorRank = Math.min(existing.vectorRank ?? rank, rank);
          existing.vectorScore = Math.max(existing.vectorScore ?? 0, t.score);
        } else {
          hits.set(t.entityId, {
            entityId: t.entityId,
            entityType: t.entityType,
            chunkText: text,
            snippet: truncate(text, 200),
            vectorRank: rank,
            vectorScore: t.score,
          });
        }
        rank += 1;
      }
    }

    // 3) fusion (Reciprocal Rank Fusion) and enrichment
    const K = 60;
    const scored = [...hits.values()]
      .map((h) => ({ h, score: (h.keywordRank !== undefined ? 1 / (K + h.keywordRank) : 0) + (h.vectorRank !== undefined ? 1 / (K + h.vectorRank) : 0) }))
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
          matchedBy: [...(h.keywordRank !== undefined ? (['keyword'] as const) : []), ...(h.vectorRank !== undefined ? (['semantic'] as const) : [])],
        },
      ];
    });
  }

  /** Documents whose content is close to a name/topic (for assignment proposals). */
  async similarEntities(text: string, types: EntityType[], limit = 10): Promise<SearchHit[]> {
    const q = normalizeName(text).split(' ').slice(0, 60).join(' ');
    return q ? this.search(q, { types, limit }) : [];
  }
}
