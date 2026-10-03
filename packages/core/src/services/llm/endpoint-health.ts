import type { AppContext } from '../../context';
import { AppError, toErrorInfo } from '../../util/errors';
import { nowIso } from '../../util/ids';

/** After a timeout or an unreachable endpoint, requests fail fast for this long instead of waiting again. */
const CIRCUIT_OPEN_MS = 60_000;

/** Health of the LLM endpoint: the status in the header and the circuit breaker after network failures (#151). */
export class EndpointHealth {
  /** Until when requests fail fast after a network failure. */
  private circuitOpenUntil = 0;

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
    this.markStatus({ state: 'ok', lastError: null });
  }

  /** A failed request; a cancellation by the user says nothing about the state of the endpoint. */
  markFailed(err: unknown, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    this.markStatus({ state: 'error', lastError: toErrorInfo(err).message });
    if (err instanceof AppError && err.category === 'network_error') this.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  }

  /** Fails fast while the endpoint was just unreachable. */
  assertCircuitClosed(): void {
    if (Date.now() >= this.circuitOpenUntil) return;
    throw new AppError('network_error', 'Der LLM-Endpunkt war eben nicht erreichbar – ich versuche es in Kürze wieder.', {
      retryable: true,
      details: `Neuer Versuch ab ${new Date(this.circuitOpenUntil).toISOString()}`,
    });
  }

  private markStatus(status: { state: 'ok' | 'error'; lastError: string | null }): void {
    this.lastStatus = { ...status, lastCheckedAt: nowIso() };
    this.ctx.events.emit('status:changed');
  }
}
