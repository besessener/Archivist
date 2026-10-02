import { AppError } from './errors';

/** Cancellation of an LLM request by the user. */
export const abortedError = () => new AppError('llm_error', 'Die LLM-Anfrage wurde abgebrochen.');

/** HTTP error of an LLM endpoint → user-facing error (shared by the text client and the agent adapters). */
export function mapHttpError(status: number, body: string): AppError {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403)
    return new AppError('llm_error', 'Der LLM-Endpunkt hat die Anmeldung abgelehnt (API-Key prüfen).', { details: `HTTP ${status}: ${snippet}` });
  if (status === 404)
    return new AppError('llm_error', 'Endpunkt oder Modell wurde nicht gefunden (Base URL und Modellname prüfen).', { details: `HTTP 404: ${snippet}` });
  if (status === 429) return new AppError('llm_error', 'Das LLM-Limit wurde erreicht. Bitte später erneut versuchen.', { retryable: true, details: snippet });
  if (status >= 500)
    return new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Serverfehler.', { retryable: true, details: `HTTP ${status}: ${snippet}` });
  return new AppError('llm_error', 'Der LLM-Endpunkt hat die Anfrage abgelehnt.', { details: `HTTP ${status}: ${snippet}` });
}
