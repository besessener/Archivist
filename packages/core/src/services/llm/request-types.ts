import type { StrictSchema } from './responses';

export interface LlmRequest {
  instructions: string;
  input: string;
  purpose: string;
  documentIds?: string[];
  json?: boolean;
  /** What the log shows instead of the start of the prompt, e.g. the question and the source titles; masked like the request. */
  preview?: string;
  /** only for the explicit connection test (sends fixed text only) */
  bypassPrivacy?: boolean;
  maxOutputTokens?: number;
  /** Structured Outputs: the strict schema sent as `text.format` (only with `json`). */
  jsonSchema?: StrictSchema | null;
  /** Appended after the input was cut to the size limit, so it always reaches the model (e.g. the correction note). */
  appendix?: string;
  /** Cancellation by the user: the running request is ended and not retried. */
  signal?: AbortSignal;
}

export interface LlmOverrides {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}
