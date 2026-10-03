export interface JobContext<P = unknown> {
  id: string;
  type: string;
  payload: P;
  attempts: number;
  report(progress: number | null, message?: string): void;
  isCancelled(): boolean;
  throwIfCancelled(): void;
  /** Aborts on cancel or quit with a `JobCancelledError` reason, so `throwIfAborted()` acts like `throwIfCancelled()`; pass it on. */
  signal: AbortSignal;
  /** Progress an earlier unfinished run stored with `saveCheckpoint` (crash, quit); null on the first run. */
  checkpoint: unknown;
  /** Stores the job's progress so a re-run after a crash or a quit can continue from there. */
  saveCheckpoint(data: unknown): void;
}

export type JobHandler<P = never> = (job: JobContext<P>) => Promise<unknown>;

/** Optional lifecycle hooks of a job type. They run after the job's final status has been stored. */
export interface JobHooks<P = unknown> {
  /** The last attempt failed and no retry follows. Not called for failures that are retried. */
  onFailed?(job: { id: string; payload: P; attempts: number }, error: unknown): void;
  /** The job ended as `cancelled`, whether it was still waiting (e.g. for a retry) or already running. */
  onCancelled?(job: { id: string; payload: P }): void;
}

export interface JobQueueOptions {
  /** Number of jobs running in parallel (default 2). */
  concurrency?: number;
  /** Wait before the first retry; every further retry waits twice as long (default 5 s). */
  retryBaseDelayMs?: number;
  /** Upper bound for the wait between two attempts (default 5 min). */
  retryMaxDelayMs?: number;
}

export type Registration = { handler: JobHandler<never>; hooks: JobHooks<never> };
