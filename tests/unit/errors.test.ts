import { describe, expect, it } from 'vitest';
import { toErrorInfo } from '../../packages/core/src/util/errors';

const withCode = (code: string) => Object.assign(new Error(`${code}: something`), { code });

describe('toErrorInfo (#234)', () => {
  it.each([
    ['ENOENT', 'nicht gefunden'],
    ['EACCES', 'Berechtigung'],
    ['EPERM', 'nicht erlaubt'],
    ['EEXIST', 'schon eine Datei'],
    ['ENOSPC', 'Speicherplatz'],
    ['EISDIR', 'Ordner'],
    ['ENOTDIR', 'Datei'],
    ['EBUSY', 'anderen Programm'],
  ])('explains %s in plain German without the error code', (code, fragment) => {
    const info = toErrorInfo(withCode(code));
    expect(info.category).toBe('filesystem_error');
    expect(info.message).toContain(fragment);
    expect(info.message).not.toContain(code);
    expect(info.details).toContain(code);
  });

  it('marks a busy file and a full disk as worth retrying', () => {
    expect(toErrorInfo(withCode('EBUSY')).retryable).toBe(true);
    expect(toErrorInfo(withCode('ENOSPC')).retryable).toBe(true);
    expect(toErrorInfo(withCode('ENOENT')).retryable).toBe(false);
  });

  it('gives an unknown error its own category instead of calling it an invalid input', () => {
    expect(toErrorInfo(new Error('boom'))).toMatchObject({ category: 'internal_error', message: 'Unerwarteter Fehler.', details: 'boom' });
  });

  it('keeps database errors apart from unknown ones', () => {
    expect(toErrorInfo(new Error('SQLITE_BUSY: database is locked')).category).toBe('database_error');
  });
});
