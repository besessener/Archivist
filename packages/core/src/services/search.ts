import type { EntityType, SearchResult } from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { chunks, decisions, documents, entities } from '../db/schema';
import { newId } from '../util/ids';
import { chunkText, normalizeName, searchStem, tokenize, truncate } from '../util/text';
import type { WorkerPool } from '../workers/pool';
import type { EmbeddingService, EmbedResult } from './embedding';
import { LOCAL_MODEL } from './embedding';
import { fuse, mergeVectorHits, type Hit } from './search-fusion';
import { keywordPass, termCoverage } from './search-keywords';
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

/** Minimum number of entities the keyword pass returns (more when the caller asks for more results). */
const FTS_ENTITY_LIMIT = 60;

/** How long a search waits for the remote query embedding before it answers with local results only. */
export const REMOTE_QUERY_EMBEDDING_TIMEOUT_MS = 2500;

type IndexedListener = (entry: { id: string; type: EntityType }) => void;

export interface SearchServiceDeps {
  ctx: AppContext;
  embedding: EmbeddingService;
  pool: WorkerPool;
  remoteAllowed?: () => boolean;
  remoteQueryTimeoutMs?: number;
}

/** Hybrid search: FTS5 (BM25) + vector similarity (cosine, computed in the worker thread), fused via RRF. */
export class SearchService {
  private readonly vectors: VectorIndex;
  private readonly indexedListeners: IndexedListener[] = [];

  private readonly ctx: AppContext;
  private readonly embedding: EmbeddingService;
  private readonly remoteAllowed: () => boolean;
  private readonly remoteQueryTimeoutMs: number;

  constructor(deps: SearchServiceDeps) {
    ({
      ctx: this.ctx,
      embedding: this.embedding,
      remoteAllowed: this.remoteAllowed = () => false,
      remoteQueryTimeoutMs: this.remoteQueryTimeoutMs = REMOTE_QUERY_EMBEDDING_TIMEOUT_MS,
    } = deps);
    const { pool } = deps;
    this.vectors = new VectorIndex({ sqlite: () => this.ctx.database.sqlite, pool });
  }

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  remove(entityId: string): void {
    this.deleteRows(entityId);
    this.vectors.remove(entityId);
  }

  /** FTS rows share their chunk's rowid (migration 0016): deleting by entity_id on the UNINDEXED FTS column scanned the whole index (#212). */
  private deleteRows(entityId: string): void {
    this.sqlite.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE entity_id = ?)').run(entityId);
    this.ctx.database.db.delete(chunks).where(eq(chunks.entityId, entityId)).run();
  }

  /** Called after every (re)indexed entry – e.g. to look for similar entries (#271). Errors of a listener are only logged. */
  onIndexed(listener: IndexedListener): void {
    this.indexedListeners.push(listener);
  }

  async index(input: IndexInput): Promise<number> {
    const parts = chunkText(input.content);
    if (parts.length === 0) parts.push(input.title);
    const embedded = await this.embedding.embed(
      parts.map((p) => `${input.title}\n${p}`),
      { allowRemote: input.allowRemoteEmbedding ?? false, purpose: 'Suchindex', documentIds: input.type === 'document' ? [input.id] : [] },
    );
    const database = this.ctx.database;
    const written: Array<{ id: string; vector: Float32Array | undefined }> = [];
    database.transaction(() => {
      this.deleteRows(input.id);
      const insertFts = this.sqlite.prepare('INSERT INTO search_fts (rowid, chunk_id, entity_id, entity_type, title, content) VALUES (?, ?, ?, ?, ?, ?)');
      parts.forEach((text, index) => {
        const chunkId = newId();
        const vector = embedded.vectors[index];
        written.push({ id: chunkId, vector });
        const { lastInsertRowid } = database.db
          .insert(chunks)
          .values({
            id: chunkId,
            entityType: input.type,
            entityId: input.id,
            idx: index,
            text,
            embedding: vector ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : null,
            embeddingModel: embedded.model,
          })
          .run();
        insertFts.run(lastInsertRowid, chunkId, input.id, input.type, input.title, text);
      });
    });
    // only after the commit: a rolled-back transaction must not leave vectors in the index
    this.vectors.replace({ id: input.id, type: input.type }, { model: embedded.model, chunks: written });
    this.notifyIndexed(input);
    return parts.length;
  }

  private notifyIndexed(input: IndexInput): void {
    for (const listener of this.indexedListeners) {
      try {
        listener({ id: input.id, type: input.type });
      } catch (err) {
        this.ctx.logger.warn('search', 'Listener after indexing failed', { error: err, id: input.id });
      }
    }
  }

  async search(query: string, opts: { types?: EntityType[]; limit?: number; allowRemoteEmbedding?: boolean } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 30;
    const types = opts.types ?? null;
    const hits = new Map<string, Hit>();
    this.addKeywordHits(hits, { query, types, limit: Math.max(FTS_ENTITY_LIMIT, limit * 2) });
    // semantic search: local vectors and – if allowed – the endpoint's embedding model
    const wantRemote = opts.allowRemoteEmbedding ?? this.remoteAllowed();
    await this.addVectorHits(hits, { query, types, remote: false });
    if (wantRemote) await this.addVectorHits(hits, { query, types, remote: true });
    const scored = fuse(hits, limit);
    return scored.length ? this.enrich(scored) : [];
  }

  /** Keyword search: best chunk per entity, type filter inside the query – the LIMIT counts entities, not chunks (#159). */
  private addKeywordHits(hits: Map<string, Hit>, spec: { query: string; types: readonly EntityType[] | null; limit: number }): void {
    try {
      for (const [rank, match] of keywordPass(this.sqlite, spec).entries()) hits.set(match.entityId, { ...match, keywordRank: rank });
    } catch (err) {
      this.ctx.logger.warn('search', 'FTS query failed', { error: err });
    }
  }

  private async addVectorHits(hits: Map<string, Hit>, pass: { query: string; types: EntityType[] | null; remote: boolean }): Promise<void> {
    const embedded = await this.embedQuery(pass.query, { remote: pass.remote });
    if (!embedded || (pass.remote && embedded.model === LOCAL_MODEL)) return;
    const vector = embedded.vectors[0];
    if (!vector) return;
    const local = embedded.model === LOCAL_MODEL;
    const top = await this.vectors.search({ model: embedded.model, vector }, { k: 40, minScore: local ? 0.22 : 0.3, types: pass.types });
    if (top.length === 0) return;
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
    mergeVectorHits(hits, { top, texts, local });
  }

  /** Embeds the query; a remote request that does not answer in time is ignored (null). */
  private async embedQuery(query: string, mode: { remote: boolean }): Promise<EmbedResult | null> {
    const pending = this.embedding.embed([query], { allowRemote: mode.remote, purpose: 'Suchanfrage' });
    if (!mode.remote) return pending;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.remoteQueryTimeoutMs);
    });
    try {
      const result = await Promise.race([pending.catch(() => null), timeout]);
      if (!result) this.ctx.logger.warn('search', 'Embedding endpoint did not answer in time – local hits only', { timeoutMs: this.remoteQueryTimeoutMs });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Titles, paths and dates of the fused hits; hits whose entity no longer exists are dropped. */
  private enrich(scored: Array<{ hit: Hit; score: number }>): SearchHit[] {
    const ids = scored.map((s) => s.hit.entityId);
    const db = this.ctx.database.db;
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const entityRows = byId(db.select().from(entities).where(inArray(entities.id, ids)).all());
    const documentRows = byId(
      db
        .select({ id: documents.id, rel: documents.archiveRelPath, src: documents.sourcePath, at: documents.archivedAt, created: documents.createdAt })
        .from(documents)
        .where(inArray(documents.id, ids))
        .all(),
    );
    const decisionRows = byId(db.select({ id: decisions.id, at: decisions.decidedAt }).from(decisions).where(inArray(decisions.id, ids)).all());
    const max = scored[0]?.score || 1;
    return scored.flatMap(({ hit, score }) => {
      const entity = entityRows.get(hit.entityId);
      if (!entity) return [];
      const d = documentRows.get(hit.entityId);
      return [
        {
          type: hit.entityType as EntityType,
          id: hit.entityId,
          title: entity.name,
          snippet: hit.snippet || truncate(hit.chunkText, 200),
          score: Math.round((score / max) * 1000) / 1000,
          path: d?.rel ?? d?.src ?? null,
          date: d ? (d.at ?? d.created) : (decisionRows.get(hit.entityId)?.at ?? entity.updatedAt),
          passage: hit.chunkText,
          matchedBy: [
            ...(hit.keywordRank !== undefined ? (['keyword'] as const) : []),
            ...(hit.vectorRank !== undefined || hit.localRank !== undefined ? (['semantic'] as const) : []),
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
    let best = rows[0]!.text;
    let bestScore = -1;
    for (const r of rows) {
      const score = termCoverage(terms, r.text);
      if (score > bestScore) {
        best = r.text;
        bestScore = score;
      }
    }
    return best;
  }

  /** Entries similar to an indexed one (#271) by chunk vectors – the endpoint's model if the entry has them, else the local ones (`local`). */
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
    const hits = await this.vectors.similarTo(
      { model, entityId },
      { k: opts.limit, minScore: local ? opts.minScore.local : opts.minScore.embeddings, types: opts.types },
    );
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
  async similarEntities(text: string, opts: { types: EntityType[]; limit?: number }): Promise<SearchHit[]> {
    const query = normalizeName(text).split(' ').slice(0, 60).join(' ');
    return query ? this.search(query, { types: opts.types, limit: opts.limit ?? 10 }) : [];
  }
}
