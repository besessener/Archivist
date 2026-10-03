/** Longest wait the client honours from a Retry-After header; the value an error carries is capped here. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** Milliseconds a Retry-After header asks to wait (delta-seconds or HTTP date), capped; undefined if absent or unusable. */
export function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const numeric = /^-?\d+(?:\.\d+)?$/.test(value);
  const ms = numeric ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms) || (numeric && ms < 0)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}
