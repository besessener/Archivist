import type { AppErrorInfo, ErrorCategory } from '@archivist/shared';
import { ZodError } from 'zod';

const MAX_RETRY_AFTER_MS = 300_000;

/** Uniform error type of the services; translated into AppErrorInfo at the IPC boundary. */
export class AppError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly options: { retryable?: boolean; details?: string; cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  /** The wait a server asked for (Retry-After), at most 5 minutes; undefined if it named none. */
  get retryAfterMs(): number | undefined {
    const { retryAfterMs } = this.options;
    return retryAfterMs === undefined ? undefined : Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS);
  }
}

export const validationError = (message: string, details?: string) => new AppError('validation_error', message, { details });
export const permissionError = (message: string, details?: string) => new AppError('permission_error', message, { details });
export const fsError = (message: string, { cause, retryable = true }: { cause?: unknown; retryable?: boolean } = {}) =>
  new AppError('filesystem_error', message, { retryable, cause, details: cause instanceof Error ? cause.message : undefined });

export function toErrorInfo(err: unknown): AppErrorInfo {
  if (err instanceof AppError) {
    return { category: err.category, message: err.message, retryable: err.retryable, details: err.options.details };
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
