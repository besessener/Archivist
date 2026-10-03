import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { AppError } from '../util/errors';
import { tasks, type TaskMap, type TaskName } from './tasks';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  current: number | null;
}

interface Waiting {
  id: number;
  task: TaskName;
  payload: unknown;
  transfer: ArrayBuffer[];
}

/** Worker thread pool for CPU-intensive tasks. Without `workerFile` everything runs inline (tests/fallback). */
export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Waiting[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly workerFile: string | null,
    private readonly size: number = Math.max(1, Math.min(3, os.cpus().length - 1)),
  ) {}

  get mode(): 'thread' | 'inline' {
    return this.workerFile ? 'thread' : 'inline';
  }

  async run<K extends TaskName>(task: K, payload: TaskMap[K]['in']): Promise<TaskMap[K]['out']> {
    if (this.closed) throw new AppError('scan_error', 'Der Worker-Pool wurde beendet.');
    if (!this.workerFile) return tasks[task](payload);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.queue.push({ id, task, payload, transfer: [] });
      this.pump();
    });
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerFile!);
    const slot: Slot = { worker, busy: false, current: null };
    worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: string; code?: string }) => {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      slot.busy = false;
      slot.current = null;
      if (request) {
        if (message.ok) request.resolve(message.result);
        else request.reject(Object.assign(new Error(message.error ?? 'Worker-Fehler'), { code: message.code }));
      }
      this.pump();
    });
    const fail = (err: Error) => {
      if (slot.current !== null) {
        this.pending.get(slot.current)?.reject(new AppError('native_module_error', 'Der Worker-Thread ist abgestürzt.', { cause: err, details: err.message }));
        this.pending.delete(slot.current);
      }
      this.slots = this.slots.filter((other) => other !== slot);
      this.pump();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) fail(new Error(`Worker beendet mit Code ${code}`));
    });
    this.slots.push(slot);
    return slot;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((candidate) => !candidate.busy);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.busy = true;
      slot.current = job.id;
      slot.worker.postMessage({ id: job.id, task: job.task, payload: job.payload });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const request of this.pending.values()) request.reject(new Error('Worker-Pool beendet'));
    this.pending.clear();
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
    this.slots = [];
  }
}
