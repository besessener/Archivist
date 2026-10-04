import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

// #215: timeline, document list and counts are read in a worker thread with its own read-only connection
let tmp: string;
let readerFile: string;
beforeAll(async () => {
  // inside the repo so that better-sqlite3 resolves – as in the packaged app
  const cache = path.resolve(__dirname, '../../node_modules/.cache/archivist-test');
  fs.mkdirSync(cache, { recursive: true });
  tmp = fs.mkdtempSync(path.join(cache, 'reader-'));
  readerFile = path.join(tmp, 'db-reader.cjs');
  await build({
    entryPoints: [path.resolve(__dirname, '../../packages/core/src/workers/db-reader-entry.ts')],
    outfile: readerFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['better-sqlite3'],
    logLevel: 'silent',
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

async function seed() {
  // a refused key fails every LLM request at once; an outage would re-queue the analysis for minutes
  app.llm.status = 401;
  const imp = await app.ok('documents:import', { paths: [app.file('in/notiz.txt', 'Eine Notiz über das Budget.')] });
  await app.services.jobs.whenIdle();
  await app.ok('decisions:create', {
    title: 'Budget',
    decisionText: 'Das Budget wird freigegeben.',
    topic: 'Finanzen',
    decidedAt: '2026-02-01',
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });
  return imp.imported[0]!.id;
}

describe('Read worker', () => {
  it('answers in a worker thread with the same results as the main connection', async () => {
    app = await createTestApp({ readerFile });
    expect(app.services.reader.mode).toBe('thread');
    const id = await seed();

    const timeline = await app.ok('timeline:get', {});
    expect(timeline).toEqual(app.services.timeline.get({}));
    expect(timeline.some((e) => e.kind === 'decision' && e.title.includes('Budget'))).toBe(true);

    const list = await app.ok('documents:list', { limit: 50 });
    expect(list.map((d) => d.id)).toEqual([id]);
    expect(list).toEqual(app.services.documents.list({ limit: 50 }));
    expect(await app.ok('documents:counts', {})).toEqual(app.services.documents.counts());
  });

  it('sees what the main process wrote right before', async () => {
    app = await createTestApp({ readerFile });
    await seed();
    expect((await app.ok('timeline:get', {})).filter((e) => e.kind === 'event')).toHaveLength(0);

    await app.ok('events:create', { title: 'Kick-off', occurredAt: '2026-03-01' });

    expect((await app.ok('timeline:get', {})).filter((e) => e.kind === 'event')).toHaveLength(1);
  });

  it('a read worker that cannot start leaves the queries on the main thread', async () => {
    app = await createTestApp({ readerFile: path.join(tmp, 'gibt-es-nicht.cjs') });
    await seed();

    const timeline = await app.ok('timeline:get', {});

    expect(timeline).toEqual(app.services.timeline.get({}));
  });
});
