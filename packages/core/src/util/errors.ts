import type { AppErrorInfo, ErrorCategory } from '@archivist/shared';
import { ZodError } from 'zod';

export interface AppErrorOptions {
  retryable?: boolean;
  details?: string;
  cause?: unknown;
  /** LLM errors: how long the endpoint asked to wait before the next request (Retry-After, capped at 5 minutes). */
  retryAfterMs?: number;
  /** LLM errors: HTTP status of the answer. */
  httpStatus?: number;
}

/** Uniform error type of the services; translated into AppErrorInfo at the IPC boundary. */
export class AppError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

export const validationError = (message: string, details?: string) => new AppError('validation_error', message, { details });
export const permissionError = (message: string, details?: string) => new AppError('permission_error', message, { details });
export const fsError = (message: string, { cause, retryable = true }: { cause?: unknown; retryable?: boolean } = {}) =>
  new AppError('filesystem_error', message, { retryable, cause, details: cause instanceof Error ? cause.message : undefined });

export function toErrorInfo(err: unknown): AppErrorInfo {
  if (err instanceof AppError) {
    const info = { category: err.category, message: err.message, retryable: err.retryable, details: err.options.details };
    return err.retryAfterMs === undefined ? info : { ...info, retryAfterMs: err.retryAfterMs };
  }
  if (err instanceof ZodError) {
    return {
      category: 'validation_error',
      message: 'Ungültige Eingabe.',
      retryable: false,
      details: err.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION|better_sqlite3\.node/.test(message)) {
    return { category: 'native_module_error', message: 'Ein natives Modul passt nicht zur Laufzeitumgebung.', retryable: false, details: message };
  }
  if (code && /^(ENOENT|EACCES|EPERM|EEXIST|ENOSPC|EISDIR|ENOTDIR|EBUSY)$/.test(code)) {
    return { category: 'filesystem_error', message: `Dateisystemfehler (${code}).`, retryable: code === 'EBUSY' || code === 'ENOSPC', details: message };
  }
  if (/SQLITE_|sqlite/i.test(message)) {
    return { category: 'database_error', message: 'Datenbankfehler.', retryable: false, details: message };
  }
  return { category: 'validation_error', message: 'Unerwarteter Fehler.', retryable: false, details: message };
}
