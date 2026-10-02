import { Worker } from 'node:worker_threads';
import type { Db } from '../db/database';
import type { Logger } from '../util/logger';
import { readTasks, type ReadTaskInput, type ReadTaskName, type ReadTaskOutput } from './read-tasks';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** runs the query on the main connection when the worker fails */
  fallback: () => unknown;
}

/** Runs read-only queries in a worker thread with its own connection (#215); inline without `workerFile` or after failures. */
export class DbReader {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** the worker failed to start or crashed repeatedly: stay inline */
  private failures = 0;

  constructor(
    private readonly db: Db,
    private readonly options: { workerFile: string | null; databaseFile: string; logger: Logger },
  ) {}

  get mode(): 'thread' | 'inline' {
    return this.useWorker() ? 'thread' : 'inline';
  }

  private useWorker(): boolean {
    return Boolean(this.options.workerFile) && this.options.databaseFile !== ':memory:' && this.failures < 3 && !this.closed;
  }

  run<K extends ReadTaskName>(task: K, input: ReadTaskInput<K>): Promise<ReadTaskOutput<K>> {
    const inline = () => (readTasks[task] as (db: Db, query: ReadTaskInput<K>) => ReadTaskOutput<K>)(this.db, input);
    if (!this.useWorker()) return Promise.resolve().then(inline);
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, fallback: inline });
      worker.postMessage({ id, task, payload: input });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerFile!, { workerData: { file: this.options.databaseFile } });
    worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const query = this.pending.get(message.id);
      if (!query) return;
      this.pending.delete(message.id);
      if (message.ok) query.resolve(message.result);
      else query.reject(new Error(message.error ?? 'Fehler im Lese-Worker'));
    });
    const fail = (err: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.failures += 1;
      this.options.logger.warn('db-reader', 'Read worker failed – queries run on the main thread', { error: err });
      // the open queries are answered from the main connection instead of failing
      for (const query of this.pending.values()) {
        try {
          query.resolve(query.fallback());
        } catch (fallbackError) {
          query.reject(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
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
    for (const query of this.pending.values()) query.reject(new Error('Lese-Worker beendet'));
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
