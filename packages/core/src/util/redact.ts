/**
 * Erkennung und Maskierung potenzieller Zugangsdaten und technischer Geheimnisse.
 * Wird vor jeder externen LLM-Übertragung und für Logs verwendet.
 */
interface Rule {
  kind: string;
  re: RegExp;
  /** Ersetzung; $1.. dürfen referenziert werden */
  replace: (match: string, ...groups: string[]) => string;
}

const SECRET_MASK = '[REDACTED:secret]';

/** Skips values that an earlier rule (or an earlier run) already masked, so a secret is counted only once. */
const NOT_MASKED = String.raw`(?!\[REDACTED:)`;

/**
 * Keys whose value is a secret. Besides the fixed words, every key ending in `key`, `secret` or `token`
 * counts (`AccountKey`, `SharedAccessKey`, `x-api-key`, `AppSecret`, `access_token` …), as is common in
 * connection strings (`Key=Value;`). The prefix is bounded so long hyphenated words cannot cause quadratic backtracking.
 */
const SECRET_KEY = String.raw`[\w-]{0,40}(?:key|secret|token)|password|passwd|pwd|passwort|kennwort|sharedaccesssignature`;

/**
 * The value of an assignment, in this order of preference:
 * a quoted value (`"…"` / `'…'`, may contain spaces and escaped quotes) or an ODBC value in braces (`{…}`) is masked completely;
 * an unquoted value directly followed by `;` (connection string) may contain spaces;
 * otherwise the value ends at whitespace, quote, brace, comma or semicolon (an unmatched opening quote or brace is kept).
 */
const SECRET_VALUE = [
  String.raw`"${NOT_MASKED}(?:[^"\\\r\n]|\\.){4,}"`,
  String.raw`'${NOT_MASKED}(?:[^'\\\r\n]|\\.){4,}'`,
  String.raw`\{${NOT_MASKED}[^}\r\n]{4,}\}`,
  String.raw`${NOT_MASKED}[^\s"';={][^"';=\r\n]{3,}(?=;)`,
  String.raw`["'{]?${NOT_MASKED}[^\s"',;{}]{4,}`,
].join('|');

const CLOSING_DELIMITER: Record<string, string> = { '"': '"', "'": "'", '{': '}' };

/** Replaces a value by the mask but keeps its quotes or braces, so the surrounding syntax stays readable. */
function maskValue(value: string): string {
  const open = value.charAt(0);
  const close = CLOSING_DELIMITER[open];
  if (close === undefined) return SECRET_MASK;
  return value.endsWith(close) ? `${open}${SECRET_MASK}${close}` : `${open}${SECRET_MASK}`;
}

const rules: Rule[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: () => '[REDACTED:private_key]' },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => '[REDACTED:aws_key]' },
  { kind: 'jwt', re: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}\b/g, replace: () => '[REDACTED:jwt]' },
  { kind: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_\w{30,}\b/g, replace: () => '[REDACTED:github_token]' },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => '[REDACTED:slack_token]' },
  { kind: 'api_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => '[REDACTED:api_key]' },
  // Google API keys: "AIza" followed by exactly 35 characters
  { kind: 'google_api_key', re: /\bAIza[\w-]{35}(?![\w-])/g, replace: () => '[REDACTED:google_api_key]' },
  { kind: 'bearer', re: /\b(Bearer)\s+[\w.~+/=-]{16,}/gi, replace: (_m, b) => `${b} [REDACTED:bearer]` },
  {
    kind: 'url_credentials',
    // the password may contain "/" and ":"; "host:8080/…@" (or "?", "#") is a port followed by a path, not a password
    re: new RegExp(String.raw`\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):(?!\d+[/?#])${NOT_MASKED}([^\s@]{3,})@`, 'gi'),
    replace: (_m, prefix) => `${prefix}:[REDACTED:password]@`,
  },
  {
    kind: 'assignment',
    re: new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)(${SECRET_VALUE})`, 'gi'),
    replace: (_m, key, sep, value) => `${key}${sep}${maskValue(value)}`,
  },
];

export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of rules) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      const groups = args.slice(0, -2).map(String);
      const [match, ...rest] = groups as [string, ...string[]];
      count += 1;
      kinds.add(rule.kind);
      return rule.replace(match, ...rest);
    });
  }
  return { text, count, kinds: [...kinds] };
}
