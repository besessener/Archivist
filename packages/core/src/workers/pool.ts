import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { releaseOcrWorker } from '../parsers/ocr';
import { AppError } from '../util/errors';
import { tasks, type TaskMap, type TaskName } from './tasks';

/** Longest a task may run in a worker; then the worker is terminated and the task fails. */
export const TASK_TIMEOUT_MS: Record<TaskName, number> = {
  hashFile: 10 * 60_000,
  extractDocument: 15 * 60_000,
  scanDirectory: 60 * 60_000,
  cosineTopK: 30_000,
};

const TIMEOUT_MESSAGE: Record<TaskName, string> = {
  hashFile: 'Das Prüfen der Datei hat zu lange gedauert und wurde abgebrochen.',
  extractDocument: 'Das Einlesen der Datei hat zu lange gedauert und wurde abgebrochen.',
  scanDirectory: 'Das Durchsuchen des Ordners hat zu lange gedauert und wurde abgebrochen.',
  cosineTopK: 'Die Suche hat zu lange gedauert und wurde abgebrochen.',
};

/** Extraction (OCR) can hold a worker for minutes; with more than one worker it never takes the last free one. */
const LONG_TASK: TaskName = 'extractDocument';

/** `user`: the user waits for it (an archive, an import, opening a file), so it is served before waiting background tasks. */
export type TaskPriority = 'user' | 'background';

export interface RunOptions {
  /** Aborting terminates the worker running the task; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Default `background`. */
  priority?: TaskPriority;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
}

interface Waiting {
  id: number;
  task: TaskName;
  payload: unknown;
  priority: TaskPriority;
}

interface Slot {
  worker: Worker;
  job: Waiting | null;
  timer: NodeJS.Timeout | null;
  retired: boolean;
}

type WorkerMessage = { id: number; ok: boolean; result?: unknown; error?: string; code?: string };

/** Worker thread pool for CPU-intensive tasks. Without `workerFile` everything runs inline (tests/fallback, no timeout). */
export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Waiting[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly workerFile: string | null,
    private readonly size: number = Math.max(1, Math.min(3, os.cpus().length - 1)),
    private readonly timeouts: Record<TaskName, number> = TASK_TIMEOUT_MS,
  ) {}

  get mode(): 'thread' | 'inline' {
    return this.workerFile ? 'thread' : 'inline';
  }

  async run<K extends TaskName>(task: K, payload: TaskMap[K]['in'], options: RunOptions = {}): Promise<TaskMap[K]['out']> {
    if (this.closed) throw new AppError('scan_error', 'Der Worker-Pool wurde beendet.');
    const { signal, priority = 'background' } = options;
    signal?.throwIfAborted();
    if (!this.workerFile) return this.runInline(task, payload, signal);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const onAbort = () => this.cancel(id, signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, dispose: () => signal?.removeEventListener('abort', onAbort) });
      this.queue.push({ id, task, payload, priority });
      this.pump();
    });
  }

  /** Inline tasks see the signal in their input (a worker payload cannot carry one); the caller is released at once on abort. */
  private runInline<K extends TaskName>(task: K, payload: TaskMap[K]['in'], signal?: AbortSignal): Promise<TaskMap[K]['out']> {
    const work: Promise<TaskMap[K]['out']> = tasks[task](signal ? { ...payload, signal } : payload);
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Abgebrochen'));
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private settle(id: number, outcome: { value: unknown } | { error: unknown }): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.dispose();
    if ('error' in outcome) request.reject(outcome.error);
    else request.resolve(outcome.value);
  }

  /** Drops a waiting task, or terminates the worker that runs it. */
  private cancel(id: number, reason: unknown): void {
    this.queue = this.queue.filter((waiting) => waiting.id !== id);
    const slot = this.slots.find((candidate) => candidate.job?.id === id);
    if (slot) this.retire(slot);
    this.settle(id, { error: reason });
    this.pump();
  }

  private retire(slot: Slot): void {
    slot.retired = true;
    slot.job = null;
    if (slot.timer) clearTimeout(slot.timer);
    this.slots = this.slots.filter((other) => other !== slot);
    void slot.worker.terminate();
  }

  private timeOut(slot: Slot, job: Waiting): void {
    this.retire(slot);
    const category = job.task === 'extractDocument' ? 'parser_error' : 'scan_error';
    this.settle(job.id, {
      error: new AppError(category, TIMEOUT_MESSAGE[job.task], { details: `${job.task}: Zeitlimit ${this.timeouts[job.task] / 1000} s` }),
    });
    this.pump();
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerFile!);
    const slot: Slot = { worker, job: null, timer: null, retired: false };
    worker.on('message', (message: WorkerMessage) => {
      if (slot.retired) return;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      slot.job = null;
      if (message.ok) this.settle(message.id, { value: message.result });
      else this.settle(message.id, { error: Object.assign(new Error(message.error ?? 'Worker-Fehler'), { code: message.code }) });
      this.pump();
    });
    const fail = (err: Error) => {
      if (slot.retired) return;
      const job = slot.job;
      this.retire(slot);
      if (job) this.settle(job.id, { error: new AppError('native_module_error', 'Der Worker-Thread ist abgestürzt.', { cause: err, details: err.message }) });
      this.pump();
    };
    worker.on('error', fail);
    // an exit with code 0 in the middle of a task leaves it unanswered just the same
    worker.on('exit', (code) => {
      if (!this.closed) fail(new Error(`Worker beendet mit Code ${code}`));
    });
    this.slots.push(slot);
    return slot;
  }

  private pump(): void {
    for (;;) {
      const idle = this.slots.find((candidate) => !candidate.job);
      if (!idle && this.slots.length >= this.size) return;
      const job = this.takeNext();
      if (!job) return;
      const slot = idle ?? this.spawn();
      slot.job = job;
      slot.timer = setTimeout(() => this.timeOut(slot, job), this.timeouts[job.task]);
      slot.worker.postMessage({ id: job.id, task: job.task, payload: job.payload });
    }
  }

  /** The oldest user task, else the oldest background task; an extraction only while another worker stays free for short tasks. */
  private takeNext(): Waiting | undefined {
    const longRunning = this.slots.filter((slot) => slot.job?.task === LONG_TASK).length;
    const longAllowed = this.size === 1 || longRunning < this.size - 1;
    const startable = (waiting: Waiting) => longAllowed || waiting.task !== LONG_TASK;
    const user = this.queue.findIndex((waiting) => waiting.priority === 'user' && startable(waiting));
    const index = user >= 0 ? user : this.queue.findIndex(startable);
    return index >= 0 ? this.queue.splice(index, 1)[0] : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.settle(id, { error: new Error('Worker-Pool beendet') });
    for (const slot of this.slots) if (slot.timer) clearTimeout(slot.timer);
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
    this.slots = [];
    if (!this.workerFile) await releaseOcrWorker();
  }
}
