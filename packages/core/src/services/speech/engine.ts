import { Worker } from 'node:worker_threads';
import { AppError } from '../../util/errors';

/** How long an unused worker keeps the model in memory. */
export const SPEECH_IDLE_MS = 5 * 60_000;
/** How long one transcription may take. */
export const SPEECH_TIMEOUT_MS = 5 * 60_000;

export interface TranscribeOptions {
  /** Folder name of the installed model. */
  model: string;
  signal: AbortSignal;
}

export interface SpeechEngine {
  /** `samples`: 16 kHz mono floats in [-1, 1]. Resolves with the recognised German text. */
  transcribe(samples: Float32Array, options: TranscribeOptions): Promise<string>;
  /** Frees the loaded model. */
  close(): Promise<void>;
}

export interface WorkerEngineOptions {
  /** Null where no bundle exists (tests): the engine then refuses to start. */
  workerFile: string | null;
  /** Passed to the worker, which loads the model from there. */
  modelsDir: string;
  /** The model needs about a gigabyte of memory: the worker ends after this long without a request. */
  idleMs: number;
  /** One transcription may take this long, then the worker is ended. */
  timeoutMs: number;
}

type WorkerReply = { ok: true; text: string } | { ok: false; error: string };

const workerFailed = (message: string, cause?: unknown) =>
  new AppError('native_module_error', message, { cause, details: cause instanceof Error ? cause.message : undefined });

/** Runs Whisper in its own worker thread, started on first use and ended again when idle, so the window never waits for it. */
export class WorkerSpeechEngine implements SpeechEngine {
  private worker: Worker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerEngineOptions) {}

  async transcribe(samples: Float32Array, { model, signal }: TranscribeOptions): Promise<string> {
    signal.throwIfAborted();
    this.clearIdleTimer();
    const worker = this.worker ?? this.spawn();
    return new Promise<string>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        settle();
      };
      const abandon = (error: Error) => {
        void this.discard(worker);
        finish(() => reject(error));
      };
      const onMessage = (reply: WorkerReply) => {
        finish(() => (reply.ok ? resolve(reply.text) : reject(workerFailed('Die Spracherkennung ist fehlgeschlagen.', new Error(reply.error)))));
        this.armIdleTimer();
      };
      const onError = (err: Error) => abandon(workerFailed('Die Spracherkennung ist abgestürzt.', err));
      const onExit = (code: number) => abandon(workerFailed('Die Spracherkennung wurde unerwartet beendet.', new Error(`Exit-Code ${code}`)));
      const onAbort = () => abandon(signal.reason instanceof Error ? signal.reason : new Error('Abgebrochen'));
      const timer = setTimeout(
        () => abandon(new AppError('internal_error', 'Die Spracherkennung hat zu lange gedauert und wurde abgebrochen.', { retryable: true })),
        this.options.timeoutMs,
      );
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ samples, model });
    });
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    if (this.worker) await this.discard(this.worker);
  }

  private spawn(): Worker {
    const { workerFile, modelsDir } = this.options;
    if (!workerFile) throw workerFailed('Die Spracherkennung ist in diesem Modus nicht verfügbar.');
    this.worker = new Worker(workerFile, { workerData: { modelsDir } });
    return this.worker;
  }

  private async discard(worker: Worker): Promise<void> {
    if (this.worker === worker) this.worker = null;
    await worker.terminate();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.close(), this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
