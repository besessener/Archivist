import type Database from 'better-sqlite3';
import type { WorkerPool } from '../workers/pool';
import { LOCAL_MODEL } from './embedding';

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

/** Where a chunk's vector comes from. */
interface ChunkRow {
  chunkId: string;
  entityId: string;
  entityType: string;
}

/** A query vector of one embedding model. */
export interface VectorQuery {
  model: string;
  vector: Float32Array;
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

  readonly dim: number;
  private readonly typeCode: (type: string) => number;

  constructor(spec: { dim: number; typeCode: (type: string) => number; maxSegmentRows: number }) {
    this.dim = spec.dim;
    this.typeCode = spec.typeCode;
    this.rowsPerSegment = Math.max(1, Math.min(spec.maxSegmentRows, Math.floor(SEGMENT_BYTES / (spec.dim * 4))));
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

  add({ chunkId, entityId, entityType }: ChunkRow, vector: Float32Array): void {
    let seg = this.segments.at(-1);
    if (!seg || seg.rows >= this.rowsPerSegment) {
      seg = this.newSegment(Math.min(INITIAL_ROWS, this.rowsPerSegment));
      this.segments.push(seg);
    }
    if (seg.rows >= seg.capacity) this.grow(seg);
    const row = seg.rows;
    const n = Math.min(vector.length, this.dim);
    seg.matrix.set(n === vector.length ? vector : vector.subarray(0, n), row * this.dim);
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

export type VectorIndexDeps = { sqlite: () => Database.Database; pool: WorkerPool; maxSegmentRows?: number };

/** In-memory vector index per embedding model (#163) in SharedArrayBuffers: a search only sends the query vector to the workers. */
export class VectorIndex {
  private readonly models = new Map<string, ModelIndex>();
  private readonly typeCodes = new Map<string, number>();
  private readonly typeNames: string[] = [''];

  private readonly sqlite: () => Database.Database;
  private readonly pool: WorkerPool;
  private readonly maxSegmentRows: number;

  constructor(deps: VectorIndexDeps) {
    ({ sqlite: this.sqlite, pool: this.pool, maxSegmentRows: this.maxSegmentRows = MAX_SEGMENT_ROWS } = deps);
  }

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
    let index: ModelIndex | null = null;
    // local vectors also live next to remote ones (#173)
    const query =
      model === LOCAL_MODEL
        ? 'SELECT id, entity_id AS entityId, entity_type AS entityType, embedding FROM chunks WHERE embedding_model = @model AND embedding IS NOT NULL ' +
          "UNION ALL SELECT id, entity_id, entity_type, local_embedding FROM chunks WHERE embedding_model != @model AND local_embedding IS NOT NULL"
        : 'SELECT id, entity_id AS entityId, entity_type AS entityType, embedding FROM chunks WHERE embedding_model = @model AND embedding IS NOT NULL';
    const rows = this.sqlite().prepare(query).iterate({ model }) as IterableIterator<{ id: string; entityId: string; entityType: string; embedding: Buffer }>;
    for (const r of rows) {
      const vector = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, Math.floor(r.embedding.byteLength / 4));
      index ??= new ModelIndex({ dim: vector.length, typeCode: this.typeCode, maxSegmentRows: this.maxSegmentRows });
      index.add({ chunkId: r.id, entityId: r.entityId, entityType: r.entityType }, vector);
    }
    if (index) this.models.set(model, index);
    return index;
  }

  /** Called after an entity's chunks were rewritten in the database. */
  replace(
    entity: { id: string; type: string },
    written: { model: string; chunks: Array<{ id: string; vector: Float32Array | undefined; localVector?: Float32Array }> },
  ): void {
    for (const m of this.models.values()) m.remove(entity.id);
    const row = (chunkId: string) => ({ chunkId, entityId: entity.id, entityType: entity.type });
    const index = this.models.get(written.model);
    if (index) for (const c of written.chunks) if (c.vector) index.add(row(c.id), c.vector);
    const local = written.model === LOCAL_MODEL ? undefined : this.models.get(LOCAL_MODEL);
    if (local) for (const c of written.chunks) if (c.localVector) local.add(row(c.id), c.localVector);
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

  /** Best score and chunk per other entry, using the entity's first `maxChunks` chunks as queries; empty without vectors of this model. */
  async similarTo(
    { model, entityId }: { model: string; entityId: string },
    opts: { k: number; minScore: number; types?: readonly string[] | null; maxChunks?: number },
  ): Promise<VectorHit[]> {
    const index = this.load(model);
    const own = index?.byEntity.get(entityId);
    if (!index || !own?.length) return [];
    const best = new Map<string, VectorHit>();
    for (const [segIndex, row] of own.slice(0, opts.maxChunks ?? 4)) {
      const seg = index.segments[segIndex];
      if (!seg) continue;
      // a copy: the shared row may be overwritten while the worker reads the query
      const vector = seg.matrix.slice(row * index.dim, (row + 1) * index.dim);
      for (const h of await this.search({ model, vector }, { k: opts.k + own.length + 1, minScore: opts.minScore, types: opts.types }))
        if (h.entityId !== entityId && (best.get(h.entityId)?.score ?? -1) < h.score) best.set(h.entityId, h);
    }
    return [...best.values()].toSorted((a, b) => b.score - a.score).slice(0, opts.k);
  }

  async search(query: VectorQuery, opts: { k: number; minScore: number; types?: readonly string[] | null }): Promise<VectorHit[]> {
    const index = this.load(query.model);
    if (!index || index.live === 0) return [];
    const typeMask = opts.types ? this.typeMask(opts.types) : null;
    if (typeMask && !typeMask.some(Boolean)) return [];
    const padded = new Float32Array(index.dim);
    padded.set(query.vector.length > index.dim ? query.vector.subarray(0, index.dim) : query.vector);
    // snapshot: rows written after this point are not part of this search
    const parts = index.segments.map((s) => ({ seg: s, matrix: s.matrix, types: s.types, rows: s.rows, chunkIds: s.chunkIds, entityIds: s.entityIds }));
    const results = await Promise.all(
      parts.map((p) =>
        this.pool.run('cosineTopK', {
          query: padded,
          matrix: p.matrix,
          types: p.types,
          rows: p.rows,
          typeMask,
          dim: index.dim,
          k: opts.k,
          minScore: opts.minScore,
        }),
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

  private typeMask(types: readonly string[]): Uint8Array {
    const mask = new Uint8Array(256);
    for (const t of types) {
      const code = this.typeCodes.get(t);
      if (code !== undefined) mask[code] = 1;
    }
    return mask;
  }
}
