import type { Transmission } from './transmission-log';
import type { LlmRequest } from './request-types';
import type { UsageTally } from './usage';

export interface Connection {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** A connection with unsaved values (settings dialog test) must not touch the shared endpoint status. */
  source: 'saved' | 'unsaved';
}

/** A request after the privacy gate: input and instructions are cut and masked, ready to send. */
export interface PreparedRequest {
  connection: Connection;
  request: LlmRequest;
  sent: string;
  instructions: string;
  /** Masked `request.schemaText`; empty without one. */
  schemaText: string;
  redactions: number;
  personalRedactions: number;
  preview: string;
  signal?: AbortSignal;
}

/** One logged transmission: its attempts (retried while `maxAttempts` allows) share one log entry. */
export interface Transfer {
  transmission: Omit<Transmission, 'success' | 'requests' | 'note' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
  source: Connection['source'];
  signal?: AbortSignal;
  attempt: (tally: UsageTally) => Promise<string>;
  maxAttempts: (err: unknown) => number;
}
