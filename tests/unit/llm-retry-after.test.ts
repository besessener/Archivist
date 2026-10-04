import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../packages/core/src/context';
import { LlmService } from '../../packages/core/src/services/llm';
import type { SecretService } from '../../packages/core/src/services/secret';
import type { SettingsService } from '../../packages/core/src/services/settings';
import { toErrorInfo } from '../../packages/core/src/util/errors';
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from '../../packages/core/src/util/retry-after';
import { Logger } from '../../packages/core/src/util/logger';

type Answer = { status: number; retryAfter?: string; body?: unknown };

/** LLM client whose endpoint answers with the scripted statuses (the last one repeats); 200 carries the text OK. */
function client(answers: Answer[], baseUrl = 'https://llm.example.test/v1') {
  const calls: number[] = [];
  const fetchImpl = async (): Promise<Response> => {
    const answer = answers[Math.min(calls.length, answers.length - 1)]!;
    calls.push(Date.now());
    const headers = answer.retryAfter ? { 'retry-after': answer.retryAfter } : undefined;
    return new Response(JSON.stringify(answer.body ?? (answer.status === 200 ? { output_text: 'OK' } : { error: { message: 'rate limited' } })), {
      status: answer.status,
      headers,
    });
  };
  const ctx = { events: { emit: () => true }, logger: new Logger(null), database: {} };
  const settings = {
    get: () => ({
      llm: { baseUrl, model: 'test-model', maxInputChars: 10000, reasoningEffort: null, timeoutMs: 5000 },
      privacy: { llmMode: 'auto' },
    }),
  };
  const llm = new LlmService({
    ctx: ctx as unknown as AppContext,
    settings: settings as unknown as SettingsService,
    secrets: { getApiKey: () => 'sk-test' } as unknown as SecretService,
    fetchImpl,
    retryDelayMs: 0,
  });
  return { llm, calls };
}

const plain = { instructions: 'Test', input: 'Hallo', purpose: 'Test' };

afterEach(() => vi.useRealTimers());

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-03T10:00:00Z');

  it.each([
    ['7', 7000],
    ['0', 0],
    [' 2.5 ', 2500],
    ['Sat, 03 Oct 2026 10:00:30 GMT', 30_000],
    ['Sat, 03 Oct 2026 09:00:00 GMT', 0],
    ['100000', MAX_RETRY_AFTER_MS],
    ['Sun, 04 Oct 2026 10:00:00 GMT', MAX_RETRY_AFTER_MS],
  ])('reads %s as %s ms (never negative, at most five minutes)', (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });

  it.each([null, undefined, '', '   ', 'soon', '-5'])('ignores an absent or unusable header: %s', (header) => {
    expect(parseRetryAfter(header, now)).toBeUndefined();
  });
});

describe('LLM client: Retry-After and rate limits', () => {
  it('waits as long as the endpoint asks before the next attempt', async () => {
    vi.useFakeTimers();
    const { llm, calls } = client([{ status: 429, retryAfter: '3' }, { status: 200 }]);

    const answer = llm.complete(plain);
    await vi.advanceTimersByTimeAsync(2900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);

    await expect(answer).resolves.toBe('OK');
    expect(calls).toHaveLength(2);
  });

  it('does not wait for more than five minutes: the retryable error carries the capped time at once', async () => {
    const { llm, calls } = client([{ status: 429, retryAfter: '3600' }, { status: 200 }]);

    const error = await llm.complete(plain).catch((err: unknown) => err);

    expect(calls).toHaveLength(1);
    expect(toErrorInfo(error)).toMatchObject({ category: 'llm_error', retryable: true, retryAfterMs: MAX_RETRY_AFTER_MS });
  });

  it('after the attempts are used up the error still names the wait of the last answer', async () => {
    const { llm, calls } = client([{ status: 503, retryAfter: '0' }]);

    const error = await llm.complete(plain).catch((err: unknown) => err);

    expect(calls).toHaveLength(3);
    expect(toErrorInfo(error)).toMatchObject({ retryable: true, retryAfterMs: 0 });
  });

  it('a user cancellation ends the wait', async () => {
    const controller = new AbortController();
    const { llm } = client([{ status: 429, retryAfter: '120' }, { status: 200 }]);

    const answer = llm.complete({ ...plain, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(answer).rejects.toThrow(/abgebrochen/);
  });

  it('a 429 counts toward the endpoint health: the next request fails fast with the wait, the connection test still goes through', async () => {
    const { llm, calls } = client([{ status: 429, retryAfter: '600' }, { status: 200 }]);
    await llm.complete(plain).catch(() => undefined);
    expect(llm.status().state).toBe('error');

    const fast = await llm.complete(plain).catch((err: unknown) => err);
    expect(calls).toHaveLength(1);
    expect(toErrorInfo(fast)).toMatchObject({ retryable: true, retryAfterMs: expect.any(Number) });
    expect((fast as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(MAX_RETRY_AFTER_MS - 5000);

    await expect(llm.complete({ ...plain, bypassPrivacy: true })).resolves.toBe('OK');
    await expect(llm.complete(plain)).resolves.toBe('OK');
  });

  it('a 429 from Claude counts toward the endpoint health as well', async () => {
    const limited = { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } };
    const { llm, calls } = client([{ status: 429, body: limited }], 'https://llm.example.test/anthropic');
    await llm.complete(plain).catch(() => undefined);
    const attempts = calls.length;

    const fast = await llm.complete(plain).catch((err: unknown) => err);

    expect(calls).toHaveLength(attempts);
    expect(toErrorInfo(fast)).toMatchObject({ retryable: true, retryAfterMs: expect.any(Number) });
  });

  it('a 429 from Claude keeps the endpoint closed for as long as its Retry-After asks', async () => {
    const limited = { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } };
    const { llm, calls } = client([{ status: 429, retryAfter: '600', body: limited }], 'https://llm.example.test/anthropic');
    const first = await llm.complete(plain).catch((err: unknown) => err);
    expect(calls).toHaveLength(1);
    expect(toErrorInfo(first)).toMatchObject({ retryable: true, retryAfterMs: MAX_RETRY_AFTER_MS });

    const fast = await llm.complete(plain).catch((err: unknown) => err);

    expect(calls).toHaveLength(1);
    expect((fast as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(MAX_RETRY_AFTER_MS - 5000);
  });

  it('without Retry-After the backoff after a 429 grows with every further 429', async () => {
    const { llm } = client([{ status: 429 }]);
    await llm.complete(plain).catch(() => undefined);
    const first = (await llm.complete(plain).catch((err: unknown) => err)) as { retryAfterMs: number };
    expect(first.retryAfterMs).toBeLessThanOrEqual(15_000);
    expect(first.retryAfterMs).toBeGreaterThan(14_000);

    await llm.complete({ ...plain, bypassPrivacy: true }).catch(() => undefined);
    const second = (await llm.complete(plain).catch((err: unknown) => err)) as { retryAfterMs: number };
    expect(second.retryAfterMs).toBeGreaterThan(29_000);
  });
});

describe('LLM client: retries of answers cut short', () => {
  const cut = (reason: string) => ({
    status: 200,
    body: { status: 'incomplete', incomplete_details: { reason }, output: [], usage: { input_tokens: 100, output_tokens: 50 } },
  });

  it('does not repeat a request that hit its output limit: the same limit would cut it again', async () => {
    const { llm, calls } = client([cut('max_output_tokens'), { status: 200 }]);

    await expect(llm.complete({ ...plain, maxOutputTokens: 50 })).rejects.toThrow(/unvollständig/);
    expect(calls).toHaveLength(1);
  });

  it('repeats an answer cut short for another reason', async () => {
    const { llm, calls } = client([cut('content_filter'), { status: 200 }]);

    await expect(llm.complete(plain)).resolves.toBe('OK');
    expect(calls).toHaveLength(2);
  });
});
