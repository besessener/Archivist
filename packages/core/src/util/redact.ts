// Masks potential credentials and technical secrets before every external LLM transmission and in logs.
interface Rule {
  kind: string;
  pattern: RegExp;
  /** Replacement; $1.. may be referenced */
  replace: (match: string, ...groups: string[]) => string;
}

const SECRET_MASK = '[REDACTED:secret]';

/** Skips values that an earlier rule (or an earlier run) already masked, so a secret is counted only once. */
const NOT_MASKED = String.raw`(?!\[REDACTED:)`;

/** Keys whose value is a secret, incl. any key ending in key/secret/token; the bounded prefix prevents quadratic backtracking. */
const SECRET_KEY = String.raw`[\w-]{0,40}(?:key|secret|token)|password|passwd|pwd|passwort|kennwort|sharedaccesssignature`;

/** Assignment value, by preference: quoted or braced whole, unquoted up to `;` (connection string), else up to a delimiter. */
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
  { kind: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: () => '[REDACTED:private_key]' },
  { kind: 'aws_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => '[REDACTED:aws_key]' },
  { kind: 'jwt', pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}\b/g, replace: () => '[REDACTED:jwt]' },
  { kind: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_\w{30,}\b/g, replace: () => '[REDACTED:github_token]' },
  { kind: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => '[REDACTED:slack_token]' },
  { kind: 'api_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => '[REDACTED:api_key]' },
  // Google API keys: "AIza" followed by exactly 35 characters
  { kind: 'google_api_key', pattern: /\bAIza[\w-]{35}(?![\w-])/g, replace: () => '[REDACTED:google_api_key]' },
  { kind: 'bearer', pattern: /\b(Bearer)\s+[\w.~+/=-]{16,}/gi, replace: (_match, scheme) => `${scheme} [REDACTED:bearer]` },
  {
    kind: 'url_credentials',
    // the password may contain "/" and ":"; "host:8080/…@" (or "?", "#") is a port followed by a path, not a password
    pattern: new RegExp(String.raw`\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):(?!\d+[/?#])${NOT_MASKED}([^\s@]{3,})@`, 'gi'),
    replace: (_match, prefix) => `${prefix}:[REDACTED:password]@`,
  },
  {
    kind: 'assignment',
    pattern: new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)(${SECRET_VALUE})`, 'gi'),
    replace: (_match, key, separator, value) => `${key}${separator}${maskValue(value)}`,
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
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const groups = args.slice(0, -2).map(String);
      const [match, ...rest] = groups as [string, ...string[]];
      count += 1;
      kinds.add(rule.kind);
      return rule.replace(match, ...rest);
    });
  }
  return { text, count, kinds: [...kinds] };
}
