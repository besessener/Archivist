import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { AppError } from '../util/errors';
import { tasks, type TaskMap, type TaskName } from './tasks';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
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

/**
 * Worker-Thread-Pool für CPU-intensive Aufgaben. Ohne `workerFile` läuft alles inline (Tests/Fallback).
 */
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.queue.push({ id, task, payload, transfer: [] });
      this.pump();
    });
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerFile!);
    const slot: Slot = { worker, busy: false, current: null };
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string; code?: string }) => {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      slot.busy = false;
      slot.current = null;
      if (p) {
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error ?? 'Worker-Fehler'), { code: msg.code }));
      }
      this.pump();
    });
    const fail = (err: Error) => {
      if (slot.current !== null) {
        this.pending.get(slot.current)?.reject(new AppError('native_module_error', 'Der Worker-Thread ist abgestürzt.', { cause: err, details: err.message }));
        this.pending.delete(slot.current);
      }
      this.slots = this.slots.filter((s) => s !== slot);
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
      let slot = this.slots.find((s) => !s.busy);
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
    for (const p of this.pending.values()) p.reject(new Error('Worker-Pool beendet'));
    this.pending.clear();
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
  }
}
