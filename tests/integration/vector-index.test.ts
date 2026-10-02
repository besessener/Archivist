import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VectorIndex } from '../../packages/core/src/services/vector-index';
import { WorkerPool } from '../../packages/core/src/workers/pool';
import { createTestApp, type TestApp } from '../helpers/harness';

function unit(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function memoryDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, idx INTEGER, text TEXT, embedding BLOB, embedding_model TEXT)');
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, 0, ?, ?, ?)');
  const add = (id: string, type: string, entity: string, vec: Float32Array, model = 'm') =>
    insert.run(id, type, entity, `text ${id}`, Buffer.from(vec.buffer), model);
  return { db, add };
}

describe('VectorIndex (#163)', () => {
  it('loads a model once (without chunk texts) and answers further searches from memory', async () => {
    const { db, add } = memoryDb();
    add('c1', 'document', 'd1', unit([1, 0, 0, 0]));
    add('c2', 'decision', 'x1', unit([0.9, 0.1, 0, 0]));
    add('c3', 'document', 'd2', unit([0, 1, 0, 0]));
    const prepare = vi.spyOn(db, 'prepare');
    const index = new VectorIndex(() => db, new WorkerPool(null));
    const q = unit([1, 0, 0, 0]);
    const first = await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5 });
    expect(first.map((h) => h.entityId)).toEqual(['d1', 'x1']);
    const loads = prepare.mock.calls.filter(([sql]) => sql.includes('FROM chunks'));
    expect(loads).toHaveLength(1);
    expect(loads[0]![0]).not.toMatch(/\btext\b/);
    await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5 });
    await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5, types: ['decision'] });
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM chunks'))).toHaveLength(1);
  });

  it('filters by type inside the scan and keeps added/removed entities in sync', async () => {
    const { db, add } = memoryDb();
    add('c1', 'document', 'd1', unit([1, 0, 0, 0]));
    add('c2', 'decision', 'x1', unit([0.9, 0.1, 0, 0]));
    const index = new VectorIndex(() => db, new WorkerPool(null));
    const q = unit([1, 0, 0, 0]);
    expect((await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5, types: ['decision'] })).map((h) => h.entityId)).toEqual(['x1']);
    expect(await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5, types: ['note'] })).toEqual([]);

    index.replace({ id: 'n1', type: 'note' }, { model: 'm', chunks: [{ id: 'c9', vector: unit([0.95, 0.05, 0, 0]) }] });
    expect((await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5, types: ['note'] })).map((h) => h.chunkId)).toEqual(['c9']);
    // replacing moves the entity to its new vector
    index.replace({ id: 'd1', type: 'document' }, { model: 'm', chunks: [{ id: 'c10', vector: unit([0, 0, 1, 0]) }] });
    expect((await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5 })).map((h) => h.entityId)).toEqual(['n1', 'x1']);
    index.remove('x1');
    expect((await index.search({ model: 'm', vector: q }, { k: 10, minScore: 0.5 })).map((h) => h.entityId)).toEqual(['n1']);
    // other models are not affected
    expect(await index.search({ model: 'other', vector: q }, { k: 10, minScore: 0 })).toEqual([]);
  });

  it('spreads large indexes over several segments and merges their top-k', async () => {
    const { db, add } = memoryDb();
    for (let i = 0; i < 25; i += 1) add(`c${i}`, 'document', `d${i}`, unit([1, i / 10, 0, 0]));
    const pool = new WorkerPool(null);
    const run = vi.spyOn(pool, 'run');
    const index = new VectorIndex(() => db, pool, 4);
    const hits = await index.search({ model: 'm', vector: unit([1, 0, 0, 0]) }, { k: 3, minScore: 0 });
    expect(hits.map((h) => h.entityId)).toEqual(['d0', 'd1', 'd2']);
    expect(run).toHaveBeenCalledTimes(7);
    for (const [, payload] of run.mock.calls) expect((payload as { matrix: Float32Array }).matrix.buffer).toBeInstanceOf(SharedArrayBuffer);
  });
});

describe('SearchService keeps the vector index current', () => {
  let app: TestApp;
  afterEach(async () => app?.cleanup());

  it('finds new notes, forgets removed ones and never loads the corpus per query', async () => {
    app = await createTestApp({ configured: false });
    const s = app.services;
    const n1 = await s.notes.create({ title: 'Gartenzaun', content: 'Der Gartenzaun wird zwei Meter hoch.' });
    const prepare = vi.spyOn(s.database.sqlite, 'prepare');
    expect((await s.search.search('Gartenzaun Meter')).map((h) => h.id)).toContain(n1.id);
    const n2 = await s.notes.create({ title: 'Gartenzaunfarbe', content: 'Der Gartenzaun wird grün gestrichen.' });
    // no keyword match (no prefix of an indexed word) – only the vectors find the new note
    const after = await s.search.search('Zaungartenfarbe');
    expect(after.find((h) => h.id === n2.id)?.matchedBy).toEqual(['semantic']);
    s.search.remove(n1.id);
    expect((await s.search.search('Gartenzaun Meter')).map((h) => h.id)).not.toContain(n1.id);
    const fullLoads = prepare.mock.calls.filter(([sql]) => /FROM chunks WHERE embedding_model/.test(sql));
    expect(fullLoads.length).toBeLessThanOrEqual(1);
  });
});

describe('vector search in real worker threads', () => {
  let tmp: string;
  let workerFile: string;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-vec-'));
    workerFile = path.join(tmp, 'worker.cjs');
    await build({
      entryPoints: [path.resolve(__dirname, '../../packages/core/src/workers/worker-entry.ts')],
      outfile: workerFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['better-sqlite3', 'sharp', 'pdfjs-dist', 'pdfjs-dist/*', 'tesseract.js', '@napi-rs/canvas'],
      logLevel: 'silent',
    });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('shares the vectors with the workers instead of copying them', async () => {
    const { db, add } = memoryDb();
    for (let i = 0; i < 10; i += 1) add(`c${i}`, i % 2 ? 'note' : 'document', `e${i}`, unit([1, i, 0, 0]));
    const pool = new WorkerPool(workerFile, 2);
    try {
      const index = new VectorIndex(() => db, pool, 3);
      const hits = await index.search({ model: 'm', vector: unit([1, 0, 0, 0]) }, { k: 2, minScore: 0, types: ['document'] });
      expect(hits.map((h) => h.entityId)).toEqual(['e0', 'e2']);
    } finally {
      await pool.close();
    }
  });
});
