import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors';

/** The daily token limit is reached: background work pauses, interactive requests ask the user first. */
export class TokenCapError extends AppError {
  constructor(public readonly cap: number) {
    super(
      'llm_error',
      `Das Tageslimit von ${cap.toLocaleString('de-DE')} Tokens ist erreicht. Erhöhe es unter Einstellungen → Datenschutz oder warte bis morgen.`,
      {
        retryable: false,
      },
    );
    this.name = 'TokenCapError';
  }
}

export const isTokenCapError = (err: unknown): err is TokenCapError => err instanceof TokenCapError;

/** Requests inside `tokenCapOverride.run(true, …)` ignore the daily limit (the user chose to continue). */
export const tokenCapOverride = new AsyncLocalStorage<true>();
