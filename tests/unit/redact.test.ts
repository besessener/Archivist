import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../packages/core/src/util/redact';

/** Eine Zeichenkette aus `n` Zeichen des Alphabets (für Grenzwerte der Mindestlängen). */
const chars = (n: number, alphabet = 'a1B2c3D4e5F6g7H8i9J0') => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

describe('Maskierung von Zugangsdaten', () => {
  describe('erkennt und ersetzt jede Art von Geheimnis', () => {
    const cases: Array<{ kind: string; input: string; expected: string }> = [
      {
        kind: 'private_key',
        input: 'vorher\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----\nnachher',
        expected: 'vorher\n[REDACTED:private_key]\nnachher',
      },
      { kind: 'aws_key', input: 'key AKIAIOSFODNN7EXAMPLE ok', expected: 'key [REDACTED:aws_key] ok' },
      { kind: 'aws_key', input: 'temp ASIAIOSFODNN7EXAMPLE ok', expected: 'temp [REDACTED:aws_key] ok' },
      {
        kind: 'jwt',
        input: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk ende',
        expected: 'token [REDACTED:jwt] ende',
      },
      { kind: 'github_token', input: `ghp_${chars(36)}`, expected: '[REDACTED:github_token]' },
      { kind: 'github_token', input: `github_pat_${chars(40)}`, expected: '[REDACTED:github_token]' },
      { kind: 'slack_token', input: 'xoxb-1234567890-abcdefghij', expected: '[REDACTED:slack_token]' },
      { kind: 'api_key', input: `sk-${chars(24)}`, expected: '[REDACTED:api_key]' },
      { kind: 'bearer', input: `Authorization: Bearer ${chars(24)}`, expected: 'Authorization: Bearer [REDACTED:bearer]' },
      { kind: 'bearer', input: `authorization: bearer ${chars(24)}`, expected: 'authorization: bearer [REDACTED:bearer]' },
      { kind: 'url_credentials', input: 'https://benutzer:geheim123@example.org/pfad', expected: 'https://benutzer:[REDACTED:password]@example.org/pfad' },
      { kind: 'assignment', input: 'password: hunter22', expected: 'password: [REDACTED:secret]' },
      { kind: 'assignment', input: 'API_KEY="abcd1234efgh"', expected: 'API_KEY="[REDACTED:secret]"' },
      { kind: 'assignment', input: 'client-secret = wert-12345;', expected: 'client-secret = [REDACTED:secret];' },
      { kind: 'assignment', input: 'Passwort=Sommer2026', expected: 'Passwort=[REDACTED:secret]' },
    ];

    for (const { kind, input, expected } of cases) {
      it(`${kind}: ${input.slice(0, 40).replace(/\n/g, '⏎')}`, () => {
        const r = redactSecrets(input);
        expect(r.text).toBe(expected);
        expect(r.kinds).toContain(kind);
        expect(r.count).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe('lässt zu kurze Werte unverändert (Grenzwerte der Mindestlängen)', () => {
    const boundaries: Array<{ name: string; short: string; long: string }> = [
      { name: 'AWS-Schlüssel (16 Zeichen nach dem Präfix)', short: `AKIA${chars(15, 'ABCDEFGH23456789')}`, long: `AKIA${chars(16, 'ABCDEFGH23456789')}` },
      { name: 'sk-Schlüssel (16 Zeichen)', short: `sk-${chars(15)}`, long: `sk-${chars(16)}` },
      { name: 'Bearer-Token (16 Zeichen)', short: `Bearer ${chars(15)}`, long: `Bearer ${chars(16)}` },
      { name: 'GitHub-Token (30 Zeichen)', short: `ghp_${chars(29)}`, long: `ghp_${chars(30)}` },
      { name: 'Slack-Token (10 Zeichen)', short: `xoxb-${chars(9)}`, long: `xoxb-${chars(10)}` },
      { name: 'Passwort in der URL (3 Zeichen)', short: 'https://user:ab@example.org', long: 'https://user:abc@example.org' },
      { name: 'Wert einer Zuweisung (4 Zeichen)', short: 'password=abc', long: 'password=abcd' },
    ];

    for (const { name, short, long } of boundaries) {
      it(name, () => {
        expect(redactSecrets(short)).toEqual({ text: short, count: 0, kinds: [] });
        expect(redactSecrets(long).count).toBe(1);
      });
    }
  });

  it('lässt gewöhnlichen Text, leere Eingaben und Wörter ohne Wertzuweisung unverändert', () => {
    for (const text of [
      '',
      'Jour Fixe am 4. Mai mit Anna und Ben.',
      'Das Passwort wird per Post verschickt.',
      'skizze-vom-projekt',
      'https://example.org/pfad',
    ]) {
      expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [] });
    }
  });

  it('zählt jeden Treffer, meldet jede Art nur einmal und maskiert mehrere Geheimnisse in einem Text', () => {
    const r = redactSecrets(`erst sk-${chars(20)} dann sk-${chars(20, 'zyxw9876')} und password=geheim99`);

    expect(r.text).toBe('erst [REDACTED:api_key] dann [REDACTED:api_key] und password=[REDACTED:secret]');
    expect(r.count).toBe(3);
    expect(r.kinds.toSorted()).toEqual(['api_key', 'assignment']);
  });

  it('enthält nach der Maskierung kein Geheimnis mehr und ist wiederholbar', () => {
    const once = redactSecrets(`token=abcdef123456 und sk-${chars(24)}`);
    const twice = redactSecrets(once.text);

    expect(once.text).not.toMatch(/abcdef123456|sk-a1B2/);
    expect(twice.text).toBe(once.text);
  });

  describe('Zuweisungen: jedes Schlüsselwort wird erkannt', () => {
    const keywords = [
      'password',
      'passwd',
      'pwd',
      'passwort',
      'kennwort',
      'secret',
      'client_secret',
      'client-secret',
      'clientsecret',
      'token',
      'api_key',
      'api-key',
      'apikey',
      'access_key',
      'access-key',
      'accesskey',
      'auth_token',
      'auth-token',
      'authtoken',
      'private_key',
      'private-key',
      'privatekey',
    ];
    for (const keyword of keywords) {
      it(keyword, () => {
        expect(redactSecrets(`${keyword}=Wert12345`).text).toBe(`${keyword}=[REDACTED:secret]`);
        expect(redactSecrets(`${keyword.toUpperCase()}: "Wert12345"`).text).toBe(`${keyword.toUpperCase()}: "[REDACTED:secret]"`);
      });
    }

    it('erkennt Trenner mit Leerraum und Anführungszeichen, aber nicht ohne Trenner', () => {
      expect(redactSecrets("token  :  'Wert12345'").text).toBe("token  :  '[REDACTED:secret]'");
      expect(redactSecrets('tokenWert12345').count).toBe(0);
    });

    it('ein Wort mit angehängtem Schlüsselwort ist kein Treffer (Wortgrenze)', () => {
      expect(redactSecrets('mypassword=Wert12345').count).toBe(0);
    });
  });

  it('Bearer-Token: auch mit mehreren Leerzeichen oder Zeilenumbruch dazwischen', () => {
    expect(redactSecrets(`Bearer    ${chars(24)}`).text).toBe('Bearer [REDACTED:bearer]');
    expect(redactSecrets(`Bearer\n${chars(24)}`).count).toBe(1);
  });
});
