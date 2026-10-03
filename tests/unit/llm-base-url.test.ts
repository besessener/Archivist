import { describe, expect, it } from 'vitest';
import { checkLlmBaseUrl } from '@archivist/shared';

describe('checkLlmBaseUrl (#209)', () => {
  it.each([
    '',
    '   ',
    'https://api.openai.com/v1',
    'HTTPS://Example.COM/v1',
    'https://resource.openai.azure.com/openai/v1/',
    'https://192.168.1.5/v1',
    'http://localhost',
    'http://localhost:11434/v1',
    'http://LOCALHOST:11434/v1',
    'http://localhost./v1',
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/v1/',
    'http://127.1.2.3/v1',
    'http://127.10.20.30/v1',
    'http://2130706433/v1',
    'http://0x7f.0.0.1/v1',
    'http://127.1/v1',
    'http://[::1]',
    'http://[::1]:8080/v1',
    'http://[0:0:0:0:0:0:0:1]/v1',
    'http://secret@localhost/v1',
    '  http://localhost:1234/v1  ',
  ])('accepts %j', (value) => {
    expect(checkLlmBaseUrl(value)).toEqual({ ok: true });
  });

  it.each([
    'http://192.168.1.5',
    'http://192.168.1.5:11434/v1',
    'http://example.com',
    'http://example.com/v1',
    'http://10.0.0.1/v1',
    'http://0.0.0.0/v1',
    'http://[::2]/v1',
    'http://[::ffff:192.168.1.5]/v1',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://128.0.0.1/v1',
    'http://11.127.0.1/v1',
    'http://evil.com/localhost',
    'http://evil.com?host=127.0.0.1',
    'http://localhost@evil.com',
    'http://127.0.0.1@evil.com',
    'http://localhost:80@evil.com',
    'http://notlocalhost',
    'http://localhost.localdomain',
    'HTTP://Example.com',
  ])('refuses clear text to a remote host: %j', (value) => {
    expect(checkLlmBaseUrl(value)).toMatchObject({ ok: false, message: expect.stringContaining('nur für localhost erlaubt') });
  });

  it.each([
    'example.com',
    'localhost:11434',
    '127.0.0.1:11434/v1',
    'not a url',
    'ftp://example.com',
    'file:///etc/passwd',
    'ws://localhost',
    'https://',
    'http://',
    '//example.com',
    'javascript:alert(1)',
  ])('refuses what is no https address: %j', (value) => {
    expect(checkLlmBaseUrl(value)).toMatchObject({ ok: false, message: expect.stringContaining('vollständige Adresse') });
  });
});
