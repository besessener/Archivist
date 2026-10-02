import type Database from 'better-sqlite3';
import type { WorkerPool } from '../workers/pool';

/** Bytes per segment; a segment is one SharedArrayBuffer, well below the per-buffer limit of V8/Electron (~2 GiB). */
const SEGMENT_BYTES = 128 * 1024 * 1024;
/** Upper bound of rows per segment, so small indexes start with small buffers. */
const MAX_SEGMENT_ROWS = 65_536;
/** Initial row capacity of a segment; it doubles until it is full. */
const INITIAL_ROWS = 1024;

interface Segment {
  /** Row vectors (row-major, `dim` floats per row) in shared memory – handed to the worker without copying. */
  matrix: Float32Array;
  /** Type code per row; 0 marks a removed row. */
  types: Uint8Array;
  chunkIds: string[];
  entityIds: string[];
  /** Rows in use (including removed ones). */
  rows: number;
  capacity: number;
}

export interface VectorHit {
  chunkId: string;
  entityId: string;
  entityType: string;
  score: number;
}

/** Vectors of one embedding model. */
class ModelIndex {
  segments: Segment[] = [];
  /** entity id → [segment, row] of its chunks */
  readonly byEntity = new Map<string, Array<[number, number]>>();
  live = 0;
  dead = 0;
  readonly rowsPerSegment: number;

  constructor(
    readonly dim: number,
    private readonly typeCode: (type: string) => number,
    maxSegmentRows: number,
  ) {
    this.rowsPerSegment = Math.max(1, Math.min(maxSegmentRows, Math.floor(SEGMENT_BYTES / (dim * 4))));
  }

  private newSegment(capacity: number): Segment {
    return {
      matrix: new Float32Array(new SharedArrayBuffer(capacity * this.dim * 4)),
      types: new Uint8Array(new SharedArrayBuffer(capacity)),
      chunkIds: [],
      entityIds: [],
      rows: 0,
      capacity,
    };
  }

  /** Grows a segment; a running search keeps reading the old buffers, which stay valid. */
  private grow(seg: Segment): void {
    const capacity = Math.min(this.rowsPerSegment, seg.capacity * 2);
    const matrix = new Float32Array(new SharedArrayBuffer(capacity * this.dim * 4));
    matrix.set(seg.matrix.subarray(0, seg.rows * this.dim));
    const types = new Uint8Array(new SharedArrayBuffer(capacity));
    types.set(seg.types.subarray(0, seg.rows));
    seg.matrix = matrix;
    seg.types = types;
    seg.capacity = capacity;
  }

  add(chunkId: string, entityId: string, entityType: string, vec: Float32Array): void {
    let seg = this.segments.at(-1);
    if (!seg || seg.rows >= this.rowsPerSegment) {
      seg = this.newSegment(Math.min(INITIAL_ROWS, this.rowsPerSegment));
      this.segments.push(seg);
    }
    if (seg.rows >= seg.capacity) this.grow(seg);
    const row = seg.rows;
    const n = Math.min(vec.length, this.dim);
    seg.matrix.set(n === vec.length ? vec : vec.subarray(0, n), row * this.dim);
    seg.types[row] = this.typeCode(entityType);
    seg.chunkIds.push(chunkId);
    seg.entityIds.push(entityId);
    seg.rows += 1;
    const pos: [number, number] = [this.segments.length - 1, row];
    const list = this.byEntity.get(entityId);
    if (list) list.push(pos);
    else this.byEntity.set(entityId, [pos]);
    this.live += 1;
  }

  remove(entityId: string): void {
    const list = this.byEntity.get(entityId);
    if (!list) return;
    for (const [s, r] of list) {
      const seg = this.segments[s]!;
      seg.types[r] = 0;
      seg.matrix.fill(0, r * this.dim, (r + 1) * this.dim);
    }
    this.byEntity.delete(entityId);
    this.live -= list.length;
    this.dead += list.length;
  }
}

/**
 * In-memory vector index per embedding model (#163). It is loaded once from `chunks` (embeddings only, no text),
 * then kept up to date by `SearchService.index/remove`. The vectors live in SharedArrayBuffers, so a search only
 * sends the query vector to the worker threads – no per-query SELECT, no matrix build, no copy on the main thread.
 */
export class VectorIndex {
  private readonly models = new Map<string, ModelIndex>();
  private readonly typeCodes = new Map<string, number>();
  private readonly typeNames: string[] = [''];

  constructor(
    private readonly sqlite: () => Database.Database,
    private readonly pool: WorkerPool,
    private readonly maxSegmentRows = MAX_SEGMENT_ROWS,
  ) {}

  private typeCode = (type: string): number => {
    let code = this.typeCodes.get(type);
    if (code === undefined) {
      code = this.typeNames.length;
      if (code > 255) throw new Error('Zu viele Entitätstypen für den Vektorindex');
      this.typeCodes.set(type, code);
      this.typeNames.push(type);
    }
    return code;
  };

  /** Loads a model's vectors on first use (streams the rows, never holds the chunk texts). */
  private load(model: string): ModelIndex | null {
    const cached = this.models.get(model);
    if (cached) return cached;
    let idx: ModelIndex | null = null;
    const rows = this.sqlite()
      .prepare('SELECT id, entity_id AS entityId, entity_type AS entityType, embedding FROM chunks WHERE embedding_model = ? AND embedding IS NOT NULL')
      .iterate(model) as IterableIterator<{ id: string; entityId: string; entityType: string; embedding: Buffer }>;
    for (const r of rows) {
      const vec = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, Math.floor(r.embedding.byteLength / 4));
      idx ??= new ModelIndex(vec.length, this.typeCode, this.maxSegmentRows);
      idx.add(r.id, r.entityId, r.entityType, vec);
    }
    if (idx) this.models.set(model, idx);
    return idx;
  }

  /** Called after an entity's chunks were rewritten in the database. */
  replace(entityId: string, entityType: string, model: string, chunks: Array<{ id: string; vector: Float32Array | undefined }>): void {
    for (const m of this.models.values()) m.remove(entityId);
    const idx = this.models.get(model);
    if (idx) {
      for (const c of chunks) if (c.vector) idx.add(c.id, entityId, entityType, c.vector);
    }
    this.compact();
  }

  remove(entityId: string): void {
    for (const m of this.models.values()) m.remove(entityId);
    this.compact();
  }

  /** Drops a model whose index is mostly removed rows; it is reloaded on the next search. */
  private compact(): void {
    for (const [model, m] of this.models) if (m.dead > 1024 && m.dead > m.live) this.models.delete(model);
  }

  /** Clears everything, e.g. when the chunks table was changed from outside. */
  invalidate(): void {
    this.models.clear();
  }

  /**
   * Entries whose chunks are closest to the chunks of `entityId` (cosine, computed in the worker like a search): the best
   * score per other entry with its best matching chunk. Uses the entity's first `maxChunks` chunks as queries. Empty when
   * the entity has no vectors of this model.
   */
  async similarTo(
    model: string,
    entityId: string,
    opts: { k: number; minScore: number; types?: readonly string[] | null; maxChunks?: number },
  ): Promise<VectorHit[]> {
    const idx = this.load(model);
    const own = idx?.byEntity.get(entityId);
    if (!idx || !own?.length) return [];
    const best = new Map<string, VectorHit>();
    for (const [segIndex, row] of own.slice(0, opts.maxChunks ?? 4)) {
      const seg = idx.segments[segIndex];
      if (!seg) continue;
      // a copy: the shared row may be overwritten while the worker reads the query
      const query = seg.matrix.slice(row * idx.dim, (row + 1) * idx.dim);
      for (const h of await this.search(model, query, { k: opts.k + own.length + 1, minScore: opts.minScore, types: opts.types }))
        if (h.entityId !== entityId && (best.get(h.entityId)?.score ?? -1) < h.score) best.set(h.entityId, h);
    }
    return [...best.values()].toSorted((a, b) => b.score - a.score).slice(0, opts.k);
  }

  async search(model: string, query: Float32Array, opts: { k: number; minScore: number; types?: readonly string[] | null }): Promise<VectorHit[]> {
    const idx = this.load(model);
    if (!idx || idx.live === 0) return [];
    let typeMask: Uint8Array | null = null;
    if (opts.types) {
      typeMask = new Uint8Array(256);
      for (const t of opts.types) {
        const code = this.typeCodes.get(t);
        if (code !== undefined) typeMask[code] = 1;
      }
      if (!typeMask.some(Boolean)) return [];
    }
    const q = new Float32Array(idx.dim);
    q.set(query.length > idx.dim ? query.subarray(0, idx.dim) : query);
    // snapshot: rows written after this point are not part of this search
    const parts = idx.segments.map((s) => ({ seg: s, matrix: s.matrix, types: s.types, rows: s.rows, chunkIds: s.chunkIds, entityIds: s.entityIds }));
    const results = await Promise.all(
      parts.map((p) =>
        this.pool.run('cosineTopK', { query: q, matrix: p.matrix, types: p.types, rows: p.rows, typeMask, dim: idx.dim, k: opts.k, minScore: opts.minScore }),
      ),
    );
    const hits: VectorHit[] = [];
    results.forEach((top, i) => {
      const p = parts[i]!;
      for (const t of top) {
        // a row removed while the worker was computing is not reported
        const code = p.seg.types[t.index] ?? 0;
        if (code === 0) continue;
        hits.push({ chunkId: p.chunkIds[t.index]!, entityId: p.entityIds[t.index]!, entityType: this.typeNames[code]!, score: t.score });
      }
    });
    return hits.toSorted((a, b) => b.score - a.score).slice(0, opts.k);
  }
}
