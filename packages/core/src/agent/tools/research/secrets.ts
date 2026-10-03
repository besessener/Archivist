import { redactSecrets } from '../../../util/redact';

export const SECRET_LABEL: Record<string, string> = {
  secret: 'Passwort/Schlüssel',
  password: 'Zugangsdaten in einer Adresse',
  zugang: 'Benutzername/Zugangsdaten',
  pin: 'PIN/PUK/TAN',
  iban: 'IBAN',
  private_key: 'privater Schlüssel',
  aws_key: 'API-Schlüssel',
  api_key: 'API-Schlüssel',
  google_api_key: 'API-Schlüssel',
  github_token: 'Zugangstoken',
  slack_token: 'Zugangstoken',
  jwt: 'Zugangstoken',
  bearer: 'Zugangstoken',
};

function validIban(raw: string): boolean {
  const iban = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const character of moved) {
    const value = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** Kinds and counts of secrets in a text – never the values. */
export function scanSecrets(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (kind: string, count = 1) => {
    if (count > 0) counts[SECRET_LABEL[kind] ?? kind] = (counts[SECRET_LABEL[kind] ?? kind] ?? 0) + count;
  };
  const redacted = redactSecrets(text).text;
  for (const m of redacted.matchAll(/\[REDACTED:(\w+)\]/g)) bump(m[1]!);
  bump('zugang', [...text.matchAll(/\b(?:benutzername|benutzerkennung|username|login|zugangsdaten|kundennummer\s+online)\s?[:=]\s?\S{2,}/gi)].length);
  bump('pin', [...text.matchAll(/\b(?:pin|puk|tan)(?:-?code|-?nummer)?\s?[:=]?\s?\d{4,8}\b/gi)].length);
  bump('iban', [...text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g)].filter((m) => validIban(m[0])).length);
  return counts;
}
