import type { EntityType, SearchResult } from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { chunks, decisions, documents, entities } from '../db/schema';
import { newId } from '../util/ids';
import { chunkText, normalizeName, tokenize, truncate } from '../util/text';
import type { WorkerPool } from '../workers/pool';
import type { EmbeddingService } from './embedding';
import { LOCAL_MODEL } from './embedding';

export interface IndexInput {
  type: EntityType;
  id: string;
  title: string;
  content: string;
  /** false: Vektoren nur lokal erzeugen */
  allowRemoteEmbedding?: boolean;
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

/** Hybride Suche: FTS5 (BM25) + Vektorähnlichkeit (Cosine, Berechnung im Worker-Thread), fusioniert per RRF. */
export class SearchService {
  constructor(
    private readonly ctx: AppContext,
    private readonly embedding: EmbeddingService,
    private readonly pool: WorkerPool,
    private readonly remoteAllowed: () => boolean = () => false,
  ) {}

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  remove(entityId: string): void {
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
    db.transaction(() => {
      this.remove(input.id);
      const insertFts = this.sqlite.prepare('INSERT INTO search_fts (chunk_id, entity_id, entity_type, title, content) VALUES (?, ?, ?, ?, ?)');
      parts.forEach((text, idx) => {
        const chunkId = newId();
        const vec = emb.vectors[idx];
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
    return parts.length;
  }

  private ftsQuery(query: string): string | null {
    const toks = tokenize(query).slice(0, 12);
    if (toks.length === 0) return null;
    return toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  }

  async search(query: string, opts: { types?: EntityType[]; limit?: number; allowRemoteEmbedding?: boolean } = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 30;
    const hits = new Map<string, Hit>();
    const typeSet = opts.types ? new Set<string>(opts.types) : null;

    // 1) Stichwortsuche
    const fts = this.ftsQuery(query);
    if (fts) {
      try {
        const rows = this.sqlite
          .prepare(
            `SELECT entity_id AS entityId, entity_type AS entityType, content AS chunkText,
                    snippet(search_fts, 4, '[', ']', '…', 14) AS snippet
             FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts, 0, 0, 0, 3.0, 1.0) LIMIT 60`,
          )
          .all(fts) as Array<{ entityId: string; entityType: string; chunkText: string; snippet: string }>;
        let rank = 0;
        for (const r of rows) {
          if (typeSet && !typeSet.has(r.entityType)) continue;
          const existing = hits.get(r.entityId);
          if (existing) continue;
          hits.set(r.entityId, { ...r, keywordRank: rank });
          rank += 1;
        }
      } catch (err) {
        this.ctx.logger.warn('search', 'FTS-Abfrage fehlgeschlagen', { error: err });
      }
    }

    // 2) Semantische Suche (lokale Vektoren und – falls erlaubt – Embedding-Modell des Endpunkts)
    const wantRemote = opts.allowRemoteEmbedding ?? this.remoteAllowed();
    let rank = 0;
    for (const useRemote of [false, true]) {
      if (useRemote && !wantRemote) continue;
      const q = await this.embedding.embed([query], { allowRemote: useRemote, purpose: 'Suchanfrage' });
      if (useRemote && q.model === LOCAL_MODEL) continue;
      const qvec = q.vectors[0];
      if (!qvec) continue;
      const rows = this.sqlite
        .prepare('SELECT id, entity_id AS entityId, entity_type AS entityType, text, embedding FROM chunks WHERE embedding_model = ? AND embedding IS NOT NULL')
        .all(q.model) as Array<{ id: string; entityId: string; entityType: string; text: string; embedding: Buffer }>;
      const filtered = typeSet ? rows.filter((r) => typeSet.has(r.entityType)) : rows;
      if (filtered.length === 0) continue;
      const dim = q.dim;
      const matrix = new Float32Array(filtered.length * dim);
      filtered.forEach((r, i) => {
        const f = new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength));
        matrix.set(f.length === dim ? f : f.subarray(0, dim), i * dim);
      });
      const top = await this.pool.run('cosineTopK', { query: qvec, matrix, dim, k: 40, minScore: q.model === LOCAL_MODEL ? 0.22 : 0.3 });
      for (const t of top) {
        const row = filtered[t.index]!;
        const existing = hits.get(row.entityId);
        if (existing) {
          existing.vectorRank = Math.min(existing.vectorRank ?? rank, rank);
          existing.vectorScore = Math.max(existing.vectorScore ?? 0, t.score);
        } else {
          hits.set(row.entityId, { entityId: row.entityId, entityType: row.entityType, chunkText: row.text, snippet: truncate(row.text, 200), vectorRank: rank, vectorScore: t.score });
        }
        rank += 1;
      }
    }

    // 3) Fusion (Reciprocal Rank Fusion) und Anreicherung
    const K = 60;
    const scored = [...hits.values()]
      .map((h) => ({ h, score: (h.keywordRank !== undefined ? 1 / (K + h.keywordRank) : 0) + (h.vectorRank !== undefined ? 1 / (K + h.vectorRank) : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (scored.length === 0) return [];
    const ids = scored.map((s) => s.h.entityId);
    const ents = new Map(this.ctx.database.db.select().from(entities).where(inArray(entities.id, ids)).all().map((e) => [e.id, e]));
    const docs = new Map(this.ctx.database.db.select({ id: documents.id, rel: documents.archiveRelPath, src: documents.sourcePath, at: documents.archivedAt, created: documents.createdAt, status: documents.status }).from(documents).where(inArray(documents.id, ids)).all().map((d) => [d.id, d]));
    const decs = new Map(this.ctx.database.db.select({ id: decisions.id, at: decisions.decidedAt }).from(decisions).where(inArray(decisions.id, ids)).all().map((d) => [d.id, d]));
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
          matchedBy: [...(h.keywordRank !== undefined ? (['keyword'] as const) : []), ...(h.vectorRank !== undefined ? (['semantic'] as const) : [])],
        },
      ];
    });
  }

  /** Dokumente, die einem Namen/Thema inhaltlich nahe sind (für Zuordnungsvorschläge). */
  async similarEntities(text: string, types: EntityType[], limit = 10): Promise<SearchResult[]> {
    const q = normalizeName(text).split(' ').slice(0, 60).join(' ');
    return q ? this.search(q, { types, limit }) : [];
  }
}
