import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys whose values never reach the log (only their length). */
const SENSITIVE_KEYS = /^(api[-_]?key|authorization|password|secret|token|content|text|prompt|input|body|extractedtext|messages?)$/i;

/**
 * Structured local JSON Lines logging.
 * Contains neither API keys nor full document contents or complete LLM requests.
 */
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
    let out = value;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED:key]');
    out = redactSecrets(out).text;
    return out.length > max ? `${out.slice(0, max)}…[+${out.length - max} chars]` : out;
  }

  private sanitize(value: unknown, depth = 0, key = ''): unknown {
    if (value == null) return value;
    if (SENSITIVE_KEYS.test(key)) {
      return typeof value === 'string' ? `[${value.length} chars not logged]` : '[not logged]';
    }
    if (typeof value === 'string') return this.sanitizeString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) return { name: value.name, message: this.sanitizeString(value.message) };
    if (depth > 4) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => this.sanitize(v, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.sanitize(v, depth + 1, k);
      return out;
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- objects and arrays are already taken apart above
    return String(value);
  }

  private write(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>): void {
    if (order[level] < order[this.level]) return;
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

  debug(scope: string, message: string, ctx?: Record<string, unknown>): void {
    this.write('debug', scope, message, ctx);
  }
  info(scope: string, message: string, ctx?: Record<string, unknown>): void {
    this.write('info', scope, message, ctx);
  }
  warn(scope: string, message: string, ctx?: Record<string, unknown>): void {
    this.write('warn', scope, message, ctx);
  }
  error(scope: string, message: string, ctx?: Record<string, unknown>): void {
    this.write('error', scope, message, ctx);
  }

  /** Deletes log files older than `days` days. */
  prune(days: number): void {
    if (!this.dir) return;
    const cutoff = Date.now() - days * 86_400_000;
    for (const f of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, f);
      try {
        if (f.endsWith('.log') && fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
    this.stream = null;
  }
}
