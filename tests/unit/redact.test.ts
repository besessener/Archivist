import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../packages/core/src/util/redact';

/** A string of `n` characters from the alphabet (for minimum length boundaries). */
const chars = (n: number, alphabet = 'a1B2c3D4e5F6g7H8i9J0') => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

describe('masking credentials', () => {
  describe('detects and replaces every kind of secret', () => {
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

  describe('leaves values that are too short unchanged (minimum length boundaries)', () => {
    const boundaries: Array<{ name: string; short: string; long: string }> = [
      { name: 'AWS key (16 characters after the prefix)', short: `AKIA${chars(15, 'ABCDEFGH23456789')}`, long: `AKIA${chars(16, 'ABCDEFGH23456789')}` },
      { name: 'sk- key (16 characters)', short: `sk-${chars(15)}`, long: `sk-${chars(16)}` },
      { name: 'bearer token (16 characters)', short: `Bearer ${chars(15)}`, long: `Bearer ${chars(16)}` },
      { name: 'GitHub token (30 characters)', short: `ghp_${chars(29)}`, long: `ghp_${chars(30)}` },
      { name: 'Slack token (10 characters)', short: `xoxb-${chars(9)}`, long: `xoxb-${chars(10)}` },
      { name: 'password in the URL (3 characters)', short: 'https://user:ab@example.org', long: 'https://user:abc@example.org' },
      { name: 'value of an assignment (4 characters)', short: 'password=abc', long: 'password=abcd' },
    ];

    for (const { name, short, long } of boundaries) {
      it(name, () => {
        expect(redactSecrets(short)).toEqual({ text: short, count: 0, kinds: [], personalData: 0 });
        expect(redactSecrets(long).count).toBe(1);
      });
    }
  });

  it('leaves ordinary text, empty input and words without a value assignment unchanged', () => {
    for (const text of [
      '',
      'Jour Fixe am 4. Mai mit Anna und Ben.',
      'Das Passwort wird per Post verschickt.',
      'skizze-vom-projekt',
      'https://example.org/pfad',
    ]) {
      expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [], personalData: 0 });
    }
  });

  it('counts every match, reports each kind only once and masks several secrets in one text', () => {
    const r = redactSecrets(`erst sk-${chars(20)} dann sk-${chars(20, 'zyxw9876')} und password=geheim99`);

    expect(r.text).toBe('erst [REDACTED:api_key] dann [REDACTED:api_key] und password=[REDACTED:secret]');
    expect(r.count).toBe(3);
    expect(r.kinds.toSorted()).toEqual(['api_key', 'assignment']);
  });

  it('contains no secret after masking and is idempotent', () => {
    const once = redactSecrets(`token=abcdef123456 und sk-${chars(24)}`);
    const twice = redactSecrets(once.text);

    expect(once.text).not.toMatch(/abcdef123456|sk-a1B2/);
    expect(twice.text).toBe(once.text);
  });

  describe('assignments: every keyword is detected', () => {
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

    it('detects separators with whitespace and quotes, but not without a separator', () => {
      expect(redactSecrets("token  :  'Wert12345'").text).toBe("token  :  '[REDACTED:secret]'");
      expect(redactSecrets('tokenWert12345').count).toBe(0);
    });

    it('a word with an attached keyword is no match (word boundary)', () => {
      expect(redactSecrets('mypassword=Wert12345').count).toBe(0);
    });
  });

  it('bearer token: also with several spaces or a line break in between', () => {
    expect(redactSecrets(`Bearer    ${chars(24)}`).text).toBe('Bearer [REDACTED:bearer]');
    expect(redactSecrets(`Bearer\n${chars(24)}`).count).toBe(1);
  });
});

describe('connection strings, Google keys and quoted values (issue #70)', () => {
  const azureKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
  const googleKey = `AIza${chars(35, 'SyB-_9xQ')}`;

  const cases: Array<{ name: string; input: string; expected: string; kind: string }> = [
    {
      name: 'Azure Storage: AccountKey',
      input: `DefaultEndpointsProtocol=https;AccountName=konto;AccountKey=${azureKey};EndpointSuffix=core.windows.net`,
      expected: 'DefaultEndpointsProtocol=https;AccountName=konto;AccountKey=[REDACTED:secret];EndpointSuffix=core.windows.net',
      kind: 'assignment',
    },
    {
      name: 'Service Bus: SharedAccessKey at the end, SharedAccessKeyName stays',
      input: 'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc123+/def=',
      expected: 'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=[REDACTED:secret]',
      kind: 'assignment',
    },
    {
      name: 'Azure SAS: SharedAccessSignature',
      input: 'BlobEndpoint=https://a.blob.core.windows.net/;SharedAccessSignature=sv=2020-08-04&ss=b&sig=abc%2Bdef',
      expected: 'BlobEndpoint=https://a.blob.core.windows.net/;SharedAccessSignature=[REDACTED:secret]',
      kind: 'assignment',
    },
    {
      name: 'SQL Server: Password with spaces up to the semicolon',
      input: 'Server=tcp:db.example.net,1433;User ID=admin;Password=my secret, pass;Encrypt=True',
      expected: 'Server=tcp:db.example.net,1433;User ID=admin;Password=[REDACTED:secret];Encrypt=True',
      kind: 'assignment',
    },
    { name: 'ODBC: Pwd in braces', input: 'Driver={ODBC};Pwd={my;pass};', expected: 'Driver={ODBC};Pwd={[REDACTED:secret]};', kind: 'assignment' },
    { name: 'any *Secret key', input: 'AppSecret = Wert12345', expected: 'AppSecret = [REDACTED:secret]', kind: 'assignment' },
    { name: 'any *Token key', input: 'refresh_token=Wert12345', expected: 'refresh_token=[REDACTED:secret]', kind: 'assignment' },
    { name: 'header-style *-key', input: 'Ocp-Apim-Subscription-Key: Wert12345', expected: 'Ocp-Apim-Subscription-Key: [REDACTED:secret]', kind: 'assignment' },
    { name: 'bare Key', input: 'Key=Wert12345', expected: 'Key=[REDACTED:secret]', kind: 'assignment' },
    {
      name: 'JSON with a camelCase key',
      input: '{"storageAccountKey": "abc def"}',
      expected: '{"storageAccountKey": "[REDACTED:secret]"}',
      kind: 'assignment',
    },
    { name: 'Google API key', input: `key ${googleKey} ok`, expected: 'key [REDACTED:google_api_key] ok', kind: 'google_api_key' },
    {
      name: 'double-quoted pass phrase with spaces',
      input: 'password = "my secret pass phrase"',
      expected: 'password = "[REDACTED:secret]"',
      kind: 'assignment',
    },
    { name: 'single-quoted pass phrase with spaces', input: "pwd: 'my secret pass'", expected: "pwd: '[REDACTED:secret]'", kind: 'assignment' },
    {
      name: 'quoted value with an escaped quote',
      input: String.raw`secret="ab\"cd ef" weiter`,
      expected: 'secret="[REDACTED:secret]" weiter',
      kind: 'assignment',
    },
    { name: 'unclosed quote keeps the quote', input: "password='abcd1234", expected: "password='[REDACTED:secret]", kind: 'assignment' },
    { name: 'unclosed brace keeps the brace', input: 'pwd={abcd1234 x', expected: 'pwd={[REDACTED:secret] x', kind: 'assignment' },
    { name: 'URL password containing "/"', input: 'https://user:pa/ss1234@host', expected: 'https://user:[REDACTED:password]@host', kind: 'url_credentials' },
    {
      name: 'URL password containing ":"',
      input: 'ftp://user:pa:ss@host/datei',
      expected: 'ftp://user:[REDACTED:password]@host/datei',
      kind: 'url_credentials',
    },
  ];

  for (const { name, input, expected, kind } of cases) {
    it(name, () => {
      expect(redactSecrets(input)).toEqual({ text: expected, count: 1, personalData: 0, kinds: [kind] });
    });
  }

  it('leaves values below the minimum length and non-secret keys unchanged', () => {
    for (const text of [
      'password = "abc"',
      "pwd='abc'",
      'Pwd={abc};',
      'Pwd=abc;',
      'password=""',
      'AccountName=konto;EndpointSuffix=core.windows.net',
      'SharedAccessKeyName=RootManageSharedAccessKey',
      'Primärschlüssel ist die Spalte id',
      `AIza${chars(34)}`,
      `AIza${chars(36)}`,
      `xAIza${chars(35)}`,
    ]) {
      expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [], personalData: 0 });
    }
  });

  it('masks values at exactly the minimum length', () => {
    expect(redactSecrets('password = "abcd"').text).toBe('password = "[REDACTED:secret]"');
    expect(redactSecrets("pwd='abcd'").text).toBe("pwd='[REDACTED:secret]'");
    expect(redactSecrets('Pwd={abcd};').text).toBe('Pwd={[REDACTED:secret]};');
    expect(redactSecrets('Pwd=ab c;').text).toBe('Pwd=[REDACTED:secret];');
  });

  it('a value with spaces ends at the line break, not at a semicolon on the next line', () => {
    expect(redactSecrets('password=abcd efgh\nweiter; ok').text).toBe('password=[REDACTED:secret] efgh\nweiter; ok');
  });

  it('a quoted value does not extend past the line end', () => {
    expect(redactSecrets('password="abcd\nefgh"').text).toBe('password="[REDACTED:secret]\nefgh"');
  });

  it('masks every URL password, regardless of the case of the scheme', () => {
    expect(redactSecrets('HTTPS://a:pa/ss1@h1 und https://b:pa:ss2@h2')).toEqual({
      text: 'HTTPS://a:[REDACTED:password]@h1 und https://b:[REDACTED:password]@h2',
      count: 2,
      personalData: 0,
      kinds: ['url_credentials'],
    });
  });

  it('digits followed by "/" count as a port, other passwords starting with digits are masked', () => {
    expect(redactSecrets('https://user:1234/ab@host').text).toBe('https://user:1234/ab@host');
    expect(redactSecrets('https://user:1234ab@host').text).toBe('https://user:[REDACTED:password]@host');
  });

  it('a port followed by a path and "@" is not a password', () => {
    for (const text of [
      'https://example.org:8080/users/@alice',
      'https://example.org:443/@anna',
      'https://example.org:8080?mail=a@b.de',
      'https://example.org:8080#a@b',
    ]) {
      expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [], personalData: 0 });
    }
  });

  it('counts a secret only once, even inside an assignment or when masking again', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactSecrets(`token=${jwt}`)).toEqual({ text: 'token=[REDACTED:jwt]', count: 1, personalData: 0, kinds: ['jwt'] });
    expect(redactSecrets(`api_key="${googleKey}"`)).toEqual({
      text: 'api_key="[REDACTED:google_api_key]"',
      count: 1,
      personalData: 0,
      kinds: ['google_api_key'],
    });

    const input = `AccountKey=${azureKey}; password = "my pass phrase"; https://u:pa/ss1@host; pwd={a;b;c}`;
    const once = redactSecrets(input);
    expect(once.count).toBe(4);
    expect(once.text).toBe('AccountKey=[REDACTED:secret]; password = "[REDACTED:secret]"; https://u:[REDACTED:password]@host; pwd={[REDACTED:secret]}');
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0, kinds: [], personalData: 0 });
  });
});
