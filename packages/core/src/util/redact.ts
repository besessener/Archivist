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

const rules: Rule[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: () => '[REDACTED:private_key]' },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => '[REDACTED:aws_key]' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => '[REDACTED:jwt]' },
  { kind: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, replace: () => '[REDACTED:github_token]' },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => '[REDACTED:slack_token]' },
  { kind: 'api_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => '[REDACTED:api_key]' },
  { kind: 'bearer', re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: (_m, b) => `${b} [REDACTED:bearer]` },
  {
    kind: 'url_credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{3,})@/gi,
    replace: (_m, prefix) => `${prefix}:[REDACTED:password]@`,
  },
  {
    kind: 'assignment',
    re: /\b(password|passwd|pwd|passwort|kennwort|secret|client[_-]?secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|private[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi,
    replace: (_m, key, sep) => `${key}${sep}[REDACTED:secret]`,
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
