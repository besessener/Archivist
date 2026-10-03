import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys whose values never reach the log (only their length). */
const SENSITIVE_KEYS = /^(api[-_]?key|authorization|password|secret|token|content|text|prompt|input|body|extractedtext|messages?)$/i;

/** All log files together stay below this size: the oldest ones go first (the file of today is kept). */
export const LOG_SIZE_CAP_BYTES = 50 * 1024 * 1024;

/** Local JSON Lines log without API keys, full document contents or complete LLM requests. */
export class Logger {
  private secrets = new Set<string>();
  private stream: fs.WriteStream | null = null;
  private currentFile = '';

  constructor(
    private readonly dir: string | null,
    private level: LogLevel = 'info',
  ) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Registers a known secret value (e.g. an API key) that is masked everywhere. */
  registerSecret(secret: string | null | undefined): void {
    if (secret && secret.length >= 6) this.secrets.add(secret);
  }

  sanitizeString(value: string, max = 400): string {
    let sanitized = value;
    for (const secret of this.secrets) sanitized = sanitized.split(secret).join('[REDACTED:key]');
    sanitized = redactSecrets(sanitized).text;
    return sanitized.length > max ? `${sanitized.slice(0, max)}…[+${sanitized.length - max} chars]` : sanitized;
  }

  /** Context of a log line as the logger itself would have written it (lines read back from older files). */
  sanitizeContext(context: Record<string, unknown>): unknown {
    return this.sanitize(context);
  }

  private sanitize(value: unknown, position: { depth: number; key?: string } = { depth: 0 }): unknown {
    const { depth, key = '' } = position;
    if (value == null) return value;
    if (SENSITIVE_KEYS.test(key)) {
      return typeof value === 'string' ? `[${value.length} chars not logged]` : '[not logged]';
    }
    if (typeof value === 'string') return this.sanitizeString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) return { name: value.name, message: this.sanitizeString(value.message) };
    if (depth > 4) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => this.sanitize(item, { depth: depth + 1 }));
    if (typeof value === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [field, item] of Object.entries(value as Record<string, unknown>)) sanitized[field] = this.sanitize(item, { depth: depth + 1, key: field });
      return sanitized;
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- objects and arrays are already taken apart above
    return String(value);
  }

  private write(level: LogLevel, entry: { scope: string; message: string; context?: Record<string, unknown> }): void {
    if (order[level] < order[this.level]) return;
    const { scope, message, context } = entry;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope,
      msg: this.sanitizeString(message, 1000),
      ...(context ? { ctx: this.sanitize(context) } : {}),
    });
    if (!this.dir) return;
    try {
      const file = path.join(this.dir, `archivist-${new Date().toISOString().slice(0, 10)}.log`);
      if (file !== this.currentFile) {
        this.stream?.end();
        this.stream = fs.createWriteStream(file, { flags: 'a' });
        this.currentFile = file;
      }
      this.stream?.write(`${line}\n`);
    } catch {
      /* logging must never crash the application */
    }
  }

  debug(scope: string, message: string, context?: Record<string, unknown>): void {
    this.write('debug', { scope, message, context });
  }
  info(scope: string, message: string, context?: Record<string, unknown>): void {
    this.write('info', { scope, message, context });
  }
  warn(scope: string, message: string, context?: Record<string, unknown>): void {
    this.write('warn', { scope, message, context });
  }
  error(scope: string, message: string, context?: Record<string, unknown>): void {
    this.write('error', { scope, message, context });
  }

  /** Deletes log files older than `days` days, then the oldest ones until all together fit into `maxBytes`. */
  prune(days: number, maxBytes = LOG_SIZE_CAP_BYTES): void {
    if (!this.dir) return;
    const cutoff = Date.now() - days * 86_400_000;
    const kept: { file: string; mtimeMs: number; size: number }[] = [];
    for (const name of fs.readdirSync(this.dir).filter((entry) => entry.endsWith('.log'))) {
      const file = path.join(this.dir, name);
      try {
        const { mtimeMs, size } = fs.statSync(file);
        if (mtimeMs < cutoff) fs.unlinkSync(file);
        else kept.push({ file, mtimeMs, size });
      } catch {
        /* a log file that vanished or is locked is pruned next time */
      }
    }
    let total = kept.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of kept.toSorted((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) return;
      if (entry.file === this.currentFile) continue;
      try {
        fs.unlinkSync(entry.file);
        total -= entry.size;
      } catch {
        /* locked: stays until the next run */
      }
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
    this.stream = null;
  }
}
