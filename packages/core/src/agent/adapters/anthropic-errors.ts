import Anthropic from '@anthropic-ai/sdk';
import { abortedError } from '../../util/llm-errors';
import { AppError } from '../../util/errors';
import { parseRetryAfter } from '../../util/retry-after';

/** SDK error → user-facing error; rate limits, server and connection errors are retryable (the core counts retries). */
export function claudeError(err: unknown, signal?: AbortSignal): Error {
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return abortedError();
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new AppError('llm_error', 'Claude hat die Anmeldung abgelehnt (API-Key prüfen).', { details: err.message });
  if (err instanceof Anthropic.NotFoundError)
    return new AppError('llm_error', 'Endpunkt oder Modell (Deployment) wurde nicht gefunden – Base URL und Modellname prüfen.', { details: err.message });
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    const message = err instanceof Anthropic.RateLimitError ? 'Das Claude-Limit wurde erreicht.' : 'Claude meldet einen Serverfehler.';
    const retryAfterMs = parseRetryAfter(err.headers?.get('retry-after'), Date.now());
    return new AppError('llm_error', message, { retryable: true, details: err.message, httpStatus: err.status, retryAfterMs });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AppError('network_error', 'Zeitüberschreitung – Claude antwortet nicht.', { retryable: true, details: err.message });
  if (err instanceof Anthropic.APIConnectionError)
    return new AppError('network_error', 'Der Claude-Endpunkt ist nicht erreichbar (Netzwerk oder Base URL prüfen).', {
      retryable: true,
      details: err.message,
    });
  if (err instanceof Anthropic.BadRequestError) return new AppError('llm_error', 'Claude hat die Anfrage abgelehnt.', { details: err.message });
  if (err instanceof Anthropic.APIError)
    return new AppError('llm_error', 'Claude meldet einen Fehler.', { details: err.message, retryable: (err.status ?? 0) >= 500 });
  if (err instanceof AppError) return err;
  // e.g. tool input JSON the tolerant parser could not read: the turn is re-issued
  return new AppError('llm_error', 'Die Antwort von Claude war unvollständig.', { retryable: true, details: err instanceof Error ? err.message : String(err) });
}
