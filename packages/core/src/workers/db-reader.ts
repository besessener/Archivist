import { Worker } from 'node:worker_threads';
import type { Db } from '../db/database';
import type { Logger } from '../util/logger';
import { readTasks, type ReadTaskInput, type ReadTaskName, type ReadTaskOutput } from './read-tasks';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** runs the query on the main connection when the worker fails */
  fallback: () => unknown;
}

/**
 * Runs read-only queries (timeline, document list, counts) in a worker thread with its own read-only database
 * connection, so they do not block the Electron main thread and every IPC call behind them (#215).
 * Without `workerFile` (tests, in-memory database) or after a worker failure the query runs inline.
 */
export class DbReader {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** the worker failed to start or crashed repeatedly: stay inline */
  private failures = 0;

  constructor(
    private readonly db: Db,
    private readonly opts: { workerFile: string | null; databaseFile: string; logger: Logger },
  ) {}

  get mode(): 'thread' | 'inline' {
    return this.useWorker() ? 'thread' : 'inline';
  }

  private useWorker(): boolean {
    return Boolean(this.opts.workerFile) && this.opts.databaseFile !== ':memory:' && this.failures < 3 && !this.closed;
  }

  run<K extends ReadTaskName>(task: K, input: ReadTaskInput<K>): Promise<ReadTaskOutput<K>> {
    const inline = () => (readTasks[task] as (d: Db, q: ReadTaskInput<K>) => ReadTaskOutput<K>)(this.db, input);
    if (!this.useWorker()) return Promise.resolve().then(inline);
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, fallback: inline });
      worker.postMessage({ id, task, payload: input });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.opts.workerFile!, { workerData: { file: this.opts.databaseFile } });
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'Fehler im Lese-Worker'));
    });
    const fail = (err: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.failures += 1;
      this.opts.logger.warn('db-reader', 'Read worker failed – queries run on the main thread', { error: err });
      // the open queries are answered from the main connection instead of failing
      for (const p of this.pending.values()) {
        try {
          p.resolve(p.fallback());
        } catch (e) {
          p.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (!this.closed) fail(new Error(`Lese-Worker beendet mit Code ${code}`));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('Lese-Worker beendet'));
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
