import { validCardNumber, validIban, validSteuerId, validSvNumber } from './checksums';
import type { RedactionRule } from './redact-rule';

/** Placeholders name the kind of data, so the model still sees that something stood there. */
const placeholder = (valid: (match: string) => boolean, label: string) => (match: string) => (valid(match) ? `[${label}]` : match);

/** A digit string is only masked when its check digit fits: order numbers and phone numbers stay readable. */
export const PERSONAL_DATA_RULES: RedactionRule[] = [
  {
    kind: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    replace: placeholder(validIban, 'IBAN'),
  },
  { kind: 'card', pattern: /(?<![\w.,])\d(?:[ -]?\d){12,18}(?!\w|[.,]\d)/g, replace: placeholder(validCardNumber, 'KARTENNUMMER') },
  { kind: 'sv_number', pattern: /(?<!\w)\d{2} ?\d{6} ?[A-Z] ?\d{3}(?!\w)/g, replace: placeholder(validSvNumber, 'SV-NUMMER') },
  { kind: 'steuer_id', pattern: /(?<![\w.,])(?:\d{11}|\d{2} \d{3} \d{3} \d{3})(?!\w|[.,]\d)/g, replace: placeholder(validSteuerId, 'STEUER-ID') },
  {
    kind: 'pin',
    pattern: /\b(PIN|PUK|TAN)((?:-?Code|-?Nummer)?(?:\s*[:=]\s*|\s+))\d{4,8}\b/g,
    replace: (_match, word, separator) => `${word}${separator}[PIN]`,
  },
  {
    kind: 'password_word',
    pattern: /\b(Kennwort|Passwort|Password|Passwd)((?:\s+(?:ist|lautet))?\s+)(?=[^\s"',;:]*\d)(?!\[)[^\s"',;:]{6,}/gi,
    replace: (_match, word, separator) => `${word}${separator}[KENNWORT]`,
  },
];
