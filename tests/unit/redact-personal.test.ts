import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../packages/core/src/util/redact';

const mask = (text: string) => redactSecrets(text).text;

describe('masking personal data with typed placeholders', () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: 'IBAN with spaces', input: 'Konto DE89 3704 0044 0532 0130 00 bitte', expected: 'Konto [IBAN] bitte' },
    { name: 'IBAN without spaces', input: 'IBAN: DE89370400440532013000.', expected: 'IBAN: [IBAN].' },
    { name: 'card number with spaces', input: 'Karte 4111 1111 1111 1111 gültig bis 12/29', expected: 'Karte [KARTENNUMMER] gültig bis 12/29' },
    { name: 'card number with hyphens', input: '4111-1111-1111-1111', expected: '[KARTENNUMMER]' },
    { name: 'Steuer-ID', input: 'Steuer-ID 86095742719 laut Bescheid', expected: 'Steuer-ID [STEUER-ID] laut Bescheid' },
    { name: 'Steuer-ID in groups', input: 'IdNr. 86 095 742 719', expected: 'IdNr. [STEUER-ID]' },
    { name: 'social security number', input: 'SV-Nr. 15070649C103', expected: 'SV-Nr. [SV-NUMMER]' },
    { name: 'social security number in groups', input: 'SV-Nr. 15 070649 C 103', expected: 'SV-Nr. [SV-NUMMER]' },
    { name: 'PIN', input: 'PIN 4711 nicht weitergeben', expected: 'PIN [PIN] nicht weitergeben' },
    { name: 'PIN with colon and code', input: 'PIN-Code: 123456', expected: 'PIN-Code: [PIN]' },
    { name: 'password without a separator', input: 'Kennwort Geheim123 für das Portal', expected: 'Kennwort [KENNWORT] für das Portal' },
    { name: 'password introduced by "ist"', input: 'Das Passwort ist Sommer2026!', expected: 'Das Passwort ist [KENNWORT]' },
  ];
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(mask(input)).toBe(expected);
    });
  }

  it('leaves numbers whose check digit does not fit, and ordinary numbers, readable', () => {
    for (const text of [
      'IBAN DE89 3704 0044 0532 0130 02',
      'Karte 4111 1111 1111 1112',
      'Rechnung 20261003 vom 03.10.2026, 1.234,56 EUR',
      'Telefon 0170 1234567, Steuernummer 21/815/08150',
      'SV-Nr. 15070649C104',
      'Steuer-ID 86095742710',
      'Das Passwort ändern wir morgen, PIN folgt per Post',
    ]) {
      expect(redactSecrets(text), text).toMatchObject({ text, count: 0, personalData: 0 });
    }
  });

  it('reports personal data apart from secrets and names the kinds', () => {
    const result = redactSecrets('password=Geheim99 und IBAN DE89 3704 0044 0532 0130 00, PIN 4711');

    expect(result.text).toBe('password=[REDACTED:secret] und IBAN [IBAN], PIN [PIN]');
    expect(result).toMatchObject({ count: 3, personalData: 2 });
    expect(result.kinds.toSorted()).toEqual(['assignment', 'iban', 'pin']);
  });

  it('leaves personal data alone when the option is off, but still masks secrets', () => {
    const result = redactSecrets('PIN 4711, DE89 3704 0044 0532 0130 00, token=Wert12345', { personalData: false });

    expect(result).toMatchObject({ text: 'PIN 4711, DE89 3704 0044 0532 0130 00, token=[REDACTED:secret]', count: 1, personalData: 0 });
  });

  it('is idempotent and does not mask the value of an already masked assignment twice', () => {
    const once = redactSecrets('Kennwort: Geheim123 und PIN 4711');

    expect(once.text).toBe('Kennwort: [REDACTED:secret] und PIN [PIN]');
    expect(redactSecrets(once.text)).toMatchObject({ text: once.text, count: 0 });
  });
});

describe('key names in assignments (issue #203)', () => {
  it('does not mask words that merely end in "key"', () => {
    for (const text of ['Monkey: Affe im Zoo am Samstag', 'Hockey: Training am Dienstag', 'Turkey = Türkei, Donkey: Esel', 'Primärschlüssel: id']) {
      expect(redactSecrets(text)).toMatchObject({ text, count: 0 });
    }
  });

  it('still masks the known key names', () => {
    for (const key of [
      'api_key',
      'accountkey',
      'AccountKey',
      'client-secret',
      'authToken',
      'refresh_token',
      'secret',
      'token',
      'Key',
      'WLAN-Schlüssel',
      'x-api-key',
    ]) {
      expect(mask(`${key}: ab12cd34ef56`), key).toBe(`${key}: [REDACTED:secret]`);
    }
  });
});
