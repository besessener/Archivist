import { describe, expect, it, vi } from 'vitest';
import { LLM_ANALYSIS_ATTEMPTS, LlmAnalysisRetry, isRetryableLlmError, mayRetryLlm, untilSettled } from '../../packages/core/src/services/analysis-retry';
import { AppError } from '../../packages/core/src/util/errors';

const rateLimit = (retryAfterMs?: number) => new AppError('llm_error', 'Limit', { retryable: true, retryAfterMs });
const requeue = (retryAfterMs?: number) => new LlmAnalysisRetry(rateLimit(retryAfterMs));

describe('Which LLM errors are tried again', () => {
  it('retries retryable LLM errors until the fifth attempt, never without a counting caller', () => {
    expect(LLM_ANALYSIS_ATTEMPTS).toBe(5);
    expect(mayRetryLlm(rateLimit(), 1)).toBe(true);
    expect(mayRetryLlm(rateLimit(), 4)).toBe(true);
    expect(mayRetryLlm(rateLimit(), 5)).toBe(false);
    expect(mayRetryLlm(rateLimit(), undefined)).toBe(false);
  });

  it('retries an unreachable endpoint and its open circuit breaker like a rate limit', () => {
    expect(isRetryableLlmError(new AppError('network_error', 'Netz', { retryable: true }))).toBe(true);
    expect(mayRetryLlm(new AppError('network_error', 'Netz', { retryable: true, retryAfterMs: 15_000 }), 1)).toBe(true);
  });

  it('leaves errors alone that retrying cannot fix', () => {
    expect(isRetryableLlmError(new AppError('network_error', 'Zeitlimit', { retryable: false }))).toBe(false);
    expect(isRetryableLlmError(new AppError('llm_error', 'Key', { retryable: false }))).toBe(false);
    expect(isRetryableLlmError(new AppError('filesystem_error', 'Datei', { retryable: true }))).toBe(false);
    expect(isRetryableLlmError(new Error('x'))).toBe(false);
  });

  it('carries the wish of the server into the re-run request', () => {
    expect(requeue(1500).retryAfterMs).toBe(1500);
    expect(requeue().retryAfterMs).toBeUndefined();
    expect(requeue().retryable).toBe(true);
  });
});

describe('Waiting for a re-run', () => {
  it('runs again after the wait the server asked for, and tells what it waits for', async () => {
    const run = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValueOnce(requeue(1)).mockResolvedValueOnce('fertig');
    const backoffMs = vi.fn(() => 99_999);
    const onWait = vi.fn();

    await expect(untilSettled(run, { backoffMs, onWait })).resolves.toBe('fertig');

    expect(run.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    expect(backoffMs).not.toHaveBeenCalled();
    expect(onWait).toHaveBeenCalledWith('Das LLM ist gerade nicht erreichbar – neuer Versuch (2 von 5)');
  });

  it('uses the backoff of the queue when the server named no time', async () => {
    const run = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValueOnce(requeue()).mockRejectedValueOnce(requeue()).mockResolvedValueOnce('ok');
    const backoffMs = vi.fn(() => 1);

    await untilSettled(run, { backoffMs });

    expect(backoffMs.mock.calls).toEqual([[1], [2]]);
  });

  it('passes on any other error at once', async () => {
    const run = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(new Error('kaputt'));

    await expect(untilSettled(run, { backoffMs: () => 0 })).rejects.toThrow('kaputt');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the job is cancelled', async () => {
    const controller = new AbortController();
    const run = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(requeue(60_000));
    const waiting = untilSettled(run, { backoffMs: () => 0, signal: controller.signal });

    controller.abort(new Error('abgebrochen'));

    await expect(waiting).rejects.toThrow('abgebrochen');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
