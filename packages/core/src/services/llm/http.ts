import type { FetchLike } from '../../agent/adapters/common';
import { AppError } from '../../util/errors';
import { abortedError } from '../../util/llm-errors';

export interface PostRequest {
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** `{baseUrl}/{pathPart}` without doubled slashes (trailing slashes of the base URL are dropped). */
export function endpointUrl(baseUrl: string, pathPart: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  return `${baseUrl.slice(0, end)}/${pathPart}`;
}

function networkError(err: unknown): AppError {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return new AppError('network_error', 'Der LLM-Endpunkt ist nicht erreichbar (Netzwerk oder Base URL prüfen).', {
    retryable: true,
    details: `${(err as Error).message}${cause?.code ? ` (${cause.code})` : ''}`,
  });
}

/** POST with both auth headers and a timeout; a user cancellation, a timeout and an unreachable endpoint become AppErrors. */
export async function postJson(fetchImpl: FetchLike, request: PostRequest): Promise<{ status: number; text: string }> {
  const { url, apiKey, body, timeoutMs, signal } = request;
  if (signal?.aborted) throw abortedError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    if (signal?.aborted) throw abortedError();
    if (controller.signal.aborted)
      throw new AppError('network_error', `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s – der LLM-Endpunkt antwortet nicht.`, {
        retryable: true,
      });
    throw networkError(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
