export class JobCancelledError extends Error {
  constructor() {
    super('Job abgebrochen');
    this.name = 'JobCancelledError';
  }
}

/** Interrupted because the app quits: the job stays `pending` and runs again after the next start (handlers treat it as cancelled). */
export class JobInterruptedError extends JobCancelledError {
  constructor() {
    super();
    this.message = 'Job beim Beenden unterbrochen';
    this.name = 'JobInterruptedError';
  }
}

/** True if `err` means "stop the job's work now": a cancellation or an interruption on quit. */
export const isJobCancelled = (err: unknown): boolean => err instanceof JobCancelledError;

/** True if `err` is an interruption on quit: the job resumes after the next start, so it is no final cancellation. */
export const isJobInterrupted = (err: unknown): boolean => err instanceof JobInterruptedError;
