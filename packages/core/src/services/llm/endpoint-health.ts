import type { AppContext } from '../../context';
import { AppError, toErrorInfo } from '../../util/errors';
import { nowIso } from '../../util/ids';

/** After a timeout or an unreachable endpoint, requests fail fast for this long instead of waiting again. */
const CIRCUIT_OPEN_MS = 60_000;

/** After a rate limit (429) without Retry-After, requests fail fast for 15 s, doubling with every further 429 up to 5 minutes. */
const RATE_LIMIT_BASE_MS = 15_000;
const RATE_LIMIT_MAX_MS = 5 * 60_000;

/** Health of the LLM endpoint: the status in the header and the circuit breaker after network failures (#151). */
export class EndpointHealth {
  /** Until when requests fail fast after a network failure. */
  private circuitOpenUntil = 0;
  /** 429 answers in a row (reset by the next success): the backoff doubles with each. */
  private rateLimitStreak = 0;

  private lastStatus: { state: 'unknown' | 'ok' | 'error'; lastError: string | null; lastCheckedAt: string | null } = {
    state: 'unknown',
    lastError: null,
    lastCheckedAt: null,
  };

  constructor(private readonly ctx: AppContext) {}

  status() {
    return { ...this.lastStatus };
  }

  markReachable(): void {
    this.circuitOpenUntil = 0;
    this.rateLimitStreak = 0;
    this.markStatus({ state: 'ok', lastError: null });
  }

  /** A failed request; a cancellation by the user says nothing about the state of the endpoint. */
  markFailed(err: unknown, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    this.markStatus({ state: 'error', lastError: toErrorInfo(err).message });
    if (!(err instanceof AppError)) return;
    if (err.category === 'network_error') this.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    if (err.options.httpStatus === 429) this.circuitOpenUntil = Date.now() + this.rateLimitBackoff(err.retryAfterMs);
  }

  private rateLimitBackoff(retryAfterMs: number | undefined): number {
    this.rateLimitStreak += 1;
    return retryAfterMs ?? Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** (this.rateLimitStreak - 1));
  }

  /** Fails fast while the endpoint was just unreachable. */
  assertCircuitClosed(): void {
    const remaining = this.circuitOpenUntil - Date.now();
    if (remaining <= 0) return;
    throw new AppError('network_error', 'Der LLM-Endpunkt war eben nicht erreichbar oder hat sein Limit gemeldet – ich versuche es in Kürze wieder.', {
      retryable: true,
      retryAfterMs: Math.min(RATE_LIMIT_MAX_MS, remaining),
      details: `Neuer Versuch ab ${new Date(this.circuitOpenUntil).toISOString()}`,
    });
  }

  private markStatus(status: { state: 'ok' | 'error'; lastError: string | null }): void {
    this.lastStatus = { ...status, lastCheckedAt: nowIso() };
    this.ctx.events.emit('status:changed');
  }
}
