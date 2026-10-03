import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../packages/core/src/util/errors';
import { sha256File } from '../../packages/core/src/util/hash';
import { TASK_TIMEOUT_MS, WorkerPool } from '../../packages/core/src/workers/pool';
import { extractFile } from '../../packages/core/src/services/document-model';
import { createTestApp } from '../helpers/harness';

let dir: string;
let workerFile: string;

// A worker that answers hashFile with the path, hangs on "hang" and exits cleanly on "exit" (the pool cannot time out inline).
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-pool-'));
  workerFile = path.join(dir, 'fake-worker.cjs');
  fs.writeFileSync(
    workerFile,
    `const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, payload }) => {
  if (payload.path === 'hang') return;
  if (payload.path === 'exit') process.exit(0);
  parentPort.postMessage({ id, ok: true, result: payload.path });
});`,
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const poolWith = (timeouts: Partial<typeof TASK_TIMEOUT_MS> = {}, size = 1) => new WorkerPool(workerFile, size, { ...TASK_TIMEOUT_MS, ...timeouts });

describe('worker pool limits (#205)', () => {
  it('terminates a worker that exceeds the task timeout, rejects with a categorised error and respawns', async () => {
    const pool = poolWith({ hashFile: 150, extractDocument: 150 });
    const hung = await pool.run('hashFile', { path: 'hang' }).catch((err: unknown) => err);
    expect(hung).toBeInstanceOf(AppError);
    expect((hung as AppError).category).toBe('scan_error');
    expect((hung as AppError).message).toMatch(/zu lange/);
    const extraction = await pool.run('extractDocument', { path: 'hang' }).catch((err: unknown) => err);
    expect((extraction as AppError).category).toBe('parser_error');
    expect(await pool.run('hashFile', { path: 'ok' })).toBe('ok');
    await pool.close();
  });

  it('keeps a slow task from blocking the tasks queued behind it', async () => {
    const pool = poolWith({ hashFile: 150 });
    const [hung, next] = await Promise.allSettled([pool.run('hashFile', { path: 'hang' }), pool.run('hashFile', { path: 'second' })]);
    expect(hung.status).toBe('rejected');
    expect(next).toEqual({ status: 'fulfilled', value: 'second' });
    await pool.close();
  });

  it('terminates the worker when the signal aborts and rejects with its reason', async () => {
    const pool = poolWith();
    const controller = new AbortController();
    const running = pool.run('hashFile', { path: 'hang' }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('Abbruch')), 50);
    await expect(running).rejects.toThrow('Abbruch');
    expect(await pool.run('hashFile', { path: 'ok' })).toBe('ok');
    await pool.close();
  });

  it('drops an aborted task that is still waiting for a slot without running it', async () => {
    const pool = poolWith({ hashFile: 400 });
    const controller = new AbortController();
    const first = pool.run('hashFile', { path: 'hang' }).catch((err: unknown) => err);
    const waiting = pool.run('hashFile', { path: 'hang' }, { signal: controller.signal });
    controller.abort(new Error('Abbruch'));
    await expect(waiting).rejects.toThrow('Abbruch');
    expect(await first).toBeInstanceOf(AppError);
    await pool.close();
  });

  it('rejects at once when the signal is already aborted, in thread and inline mode', async () => {
    const aborted = AbortSignal.abort(new Error('schon abgebrochen'));
    const pool = poolWith();
    await expect(pool.run('hashFile', { path: 'ok' }, { signal: aborted })).rejects.toThrow('schon abgebrochen');
    await pool.close();
    const inline = new WorkerPool(null);
    await expect(inline.run('hashFile', { path: __filename }, { signal: aborted })).rejects.toThrow('schon abgebrochen');
  });

  it('releases an inline caller on abort and stops hashing', async () => {
    const inline = new WorkerPool(null);
    const controller = new AbortController();
    const running = inline.run('hashFile', { path: __filename }, { signal: controller.signal });
    controller.abort(new Error('Abbruch'));
    await expect(running).rejects.toThrow('Abbruch');
    await expect(sha256File(__filename, AbortSignal.abort(new Error('weg')))).rejects.toThrow();
    expect(await sha256File(__filename)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('settles the task when a worker exits cleanly in the middle of it', async () => {
    const pool = poolWith();
    const exited = await pool.run('hashFile', { path: 'exit' }).catch((err: unknown) => err);
    expect(exited).toBeInstanceOf(AppError);
    expect((exited as AppError).message).toMatch(/Worker-Thread/);
    expect(await pool.run('hashFile', { path: 'ok' })).toBe('ok');
    await pool.close();
  });

  it('rejects pending tasks on close', async () => {
    const pool = poolWith();
    const rejection = expect(pool.run('hashFile', { path: 'hang' })).rejects.toThrow(/beendet/);
    await pool.close();
    await rejection;
  });
});

describe('search runs on its own worker', () => {
  it('does not share a pool with extraction and hashing', async () => {
    const app = await createTestApp({ privacy: 'auto' });
    expect(app.services.searchPool).not.toBe(app.services.pool);
    await app.cleanup();
  });
});

describe('job cancellation reaches the worker', () => {
  it('hands the job signal to the pool when a file is extracted', async () => {
    const controller = new AbortController();
    const received: unknown[] = [];
    const deps = {
      ctx: { paths: { index: dir } },
      settings: { get: () => ({ ocr: { enabled: false, languages: 'deu' } }) },
      pool: { run: (_task: string, _payload: unknown, options: unknown) => (received.push(options), Promise.resolve({})) },
    };
    await extractFile(deps as never, 'x.pdf', controller.signal);
    expect(received).toEqual([{ signal: controller.signal }]);
  });
});
