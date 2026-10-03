import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../util/errors';

/** LLM attempts per document (rate limit, outage) before the analysis falls back to the local classification. */
export const LLM_ANALYSIS_ATTEMPTS = 5;

/** A retryable LLM error that asks to run the analysis again later instead of falling back to the local classification. */
export class LlmAnalysisRetry extends AppError {
  constructor(cause: AppError) {
    super('llm_error', cause.message, { retryable: true, details: cause.options.details, cause, retryAfterMs: cause.retryAfterMs });
    this.name = 'LlmAnalysisRetry';
  }
}

export const isRetryableLlmError = (err: unknown): err is AppError => err instanceof AppError && err.category === 'llm_error' && err.retryable;

/** Whether a failed LLM request of attempt number `attempt` (1-based) is tried again instead of downgraded. */
export const mayRetryLlm = (err: unknown, attempt: number | undefined): err is AppError =>
  attempt !== undefined && attempt < LLM_ANALYSIS_ATTEMPTS && isRetryableLlmError(err);

/** Runs an analysis step; while a retryable LLM error asks for a re-run it waits (Retry-After or backoff) and tries again, up to the attempt limit. */
export async function untilSettled<T>(
  run: (attempt: number) => Promise<T>,
  options: { backoffMs: (failedAttempts: number) => number; signal?: AbortSignal; onWait?: (message: string) => void },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (err) {
      if (!(err instanceof LlmAnalysisRetry)) throw err;
      options.onWait?.(`Das LLM ist gerade nicht erreichbar – neuer Versuch (${attempt + 1} von ${LLM_ANALYSIS_ATTEMPTS})`);
      try {
        await sleep(err.retryAfterMs ?? options.backoffMs(attempt), undefined, { signal: options.signal });
      } catch (aborted) {
        options.signal?.throwIfAborted(); // a cancelled job stops with its own error
        throw aborted;
      }
    }
  }
}
