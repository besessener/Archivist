import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Schlüssel, deren Werte niemals ins Log gelangen (nur Länge). */
const SENSITIVE_KEYS = /^(api[-_]?key|authorization|password|secret|token|content|text|prompt|input|body|extractedtext|messages?)$/i;

/**
 * Strukturiertes lokales JSON-Lines-Logging.
 * Enthält weder API-Keys noch vollständige Dokumentinhalte oder komplette LLM-Requests.
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

  /** Registriert einen bekannten geheimen Wert (z. B. API-Key), der überall maskiert wird. */
  registerSecret(secret: string | null | undefined): void {
    if (secret && secret.length >= 6) this.secrets.add(secret);
  }

  sanitizeString(value: string, max = 400): string {
    let out = value;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED:key]');
    out = redactSecrets(out).text;
    return out.length > max ? `${out.slice(0, max)}…[+${out.length - max} Zeichen]` : out;
  }

  private sanitize(value: unknown, depth = 0, key = ''): unknown {
    if (value == null) return value;
    if (SENSITIVE_KEYS.test(key)) {
      return typeof value === 'string' ? `[${value.length} Zeichen nicht protokolliert]` : '[nicht protokolliert]';
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
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Objekte und Arrays sind oben bereits zerlegt
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
      /* Logging darf die Anwendung nie zum Absturz bringen */
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

  /** Löscht Logdateien, die älter als `days` Tage sind. */
  prune(days: number): void {
    if (!this.dir) return;
    const cutoff = Date.now() - days * 86_400_000;
    for (const f of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, f);
      try {
        if (f.endsWith('.log') && fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignorieren */
      }
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
    this.stream = null;
  }
}
