import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertRealInside,
  ensureDirSync,
  isForbiddenScanRoot,
  isInside,
  isWithinCategoryFolder,
  normalizeFsPath,
  realpathDeepest,
  resolveInside,
  sanitizeCategoryPath,
  sanitizeFileName,
  sanitizeFolderName,
  splitExtension,
  uniquePath,
} from '../../packages/core/src/util/paths';
import { scanDirectory } from '../../packages/core/src/workers/tasks';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-paths-'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('path normalisation and path traversal protection', () => {
  it('detects paths inside a root directory', () => {
    expect(isInside('/a/b', '/a/b/c/d.txt')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
    expect(isInside('/a/b', '/a/b/..foo/x')).toBe(true);
  });

  it('rejects traversal, absolute paths and null bytes', () => {
    expect(() => resolveInside('/arch', '../etc/passwd')).toThrow();
    expect(() => resolveInside('/arch', 'work/../../x')).toThrow();
    expect(() => resolveInside('/arch', '/etc/passwd')).toThrow();
    expect(() => resolveInside('/arch', 'C:\\Windows')).toThrow();
    expect(() => resolveInside('/arch', 'a\0b')).toThrow();
    expect(resolveInside('/arch', 'work/projects/x')).toBe(path.resolve('/arch/work/projects/x'));
  });

  it('sanitises category paths and forbids relative segments', () => {
    expect(sanitizeCategoryPath('work\\projects//prod-plat/')).toBe('work/projects/prod-plat');
    expect(() => sanitizeCategoryPath('work/../../etc')).toThrow();
    expect(() => sanitizeCategoryPath('/abs')).toThrow();
    expect(() => sanitizeCategoryPath('   ')).toThrow();
  });

  it('makes file names valid across platforms', () => {
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('  ..hidden. ')).toBe('hidden');
    expect(sanitizeFileName('')).toBe('Dokument');
    expect(sanitizeFileName('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(160);
  });

  it('assigns free file names instead of overwriting', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'u-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    fs.writeFileSync(path.join(dir, 'a (2).txt'), '2');
    expect(path.basename(await uniquePath(dir, 'a.txt'))).toBe('a (3).txt');
  });

  it('forbids system directories and roots as scan directory', () => {
    expect(isForbiddenScanRoot('/')).toBeTruthy();
    expect(isForbiddenScanRoot('/etc')).toBeTruthy();
    expect(isForbiddenScanRoot('/usr/share')).toBeTruthy();
    expect(isForbiddenScanRoot('/home/other/Documents', { home: '/home/me' })).toBeTruthy();
    expect(isForbiddenScanRoot('/home/me/Downloads', { home: '/home/me' })).toBeNull();
  });
});

describe('symlink escape and scan scope limits', () => {
  it('detects symlinks that lead out of the scope', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    await expect(assertRealInside(root, path.join(root, 'link', 'x.txt'))).rejects.toThrow(/außerhalb|heraus/i);
    await expect(assertRealInside(root, path.join(root, 'neu', 'x.txt'))).resolves.toBeTruthy();
  });

  it('scans only inside the permitted scope and follows no escaping links', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'scan-'));
    const outside = fs.mkdtempSync(path.join(tmp, 'secret-'));
    fs.writeFileSync(path.join(outside, 'geheim.txt'), 'geheim');
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'tief.md'), '# tief');
    fs.mkdirSync(path.join(root, 'skipme'));
    fs.writeFileSync(path.join(root, 'skipme', 'x.txt'), 'x');
    fs.writeFileSync(path.join(root, 'groß.txt'), 'x'.repeat(5000));
    fs.writeFileSync(path.join(root, 'ignored.exe'), 'bin');
    fs.writeFileSync(path.join(root, '.versteckt.txt'), 'h');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    fs.symlinkSync(path.join(outside, 'geheim.txt'), path.join(root, 'file-escape.txt'));
    fs.symlinkSync(root, path.join(root, 'sub', 'loop'));
    const res = await scanDirectory({
      root,
      recursive: true,
      excludedDirs: [path.join(root, 'skipme')],
      excludedFiles: [],
      extensions: ['txt', 'md'],
      maxSizeBytes: 1000,
    });
    const names = res.entries.map((e) => path.relative(root, e.path)).sort();
    expect(names).toEqual(['ok.txt', path.join('sub', 'tief.md')]);
    expect(res.skipped.some((s) => s.path.endsWith('file-escape.txt'))).toBe(true);
    expect(res.skipped.some((s) => s.reason.includes('maximale Größe'))).toBe(true);
  });

  it('honours "not recursive" and file exclusions', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'flat-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b');
    fs.mkdirSync(path.join(root, 'd'));
    fs.writeFileSync(path.join(root, 'd', 'c.txt'), 'c');
    const res = await scanDirectory({
      root,
      recursive: false,
      excludedDirs: [],
      excludedFiles: [path.join(root, 'b.txt')],
      extensions: ['txt'],
      maxSizeBytes: 1e6,
    });
    expect(res.entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('reports the file limit only when a further matching file exists', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'limit-'));
    for (const n of ['a.txt', 'b.txt', 'c.md']) fs.writeFileSync(path.join(root, n), n);
    const base = { root, recursive: true, excludedDirs: [], excludedFiles: [], maxSizeBytes: 1e6 };
    // c.md does not match: exactly two matching files at a limit of two is complete
    const exact = await scanDirectory({ ...base, extensions: ['txt'], maxFiles: 2 });
    expect(exact.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
    expect(exact.limitReached).toBe(false);
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'd.txt'), 'd');
    const truncated = await scanDirectory({ ...base, extensions: ['txt'], maxFiles: 2 });
    expect(truncated.entries).toHaveLength(2);
    expect(truncated.limitReached).toBe(true);
  });

  it('lists entries that could not be read as unreadable', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'unreadable-'));
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.symlinkSync(path.join(root, 'gibt-es-nicht'), path.join(root, 'kaputt'));
    const res = await scanDirectory({ root, recursive: true, excludedDirs: [], excludedFiles: [], extensions: ['txt'], maxSizeBytes: 1e6 });
    expect(res.entries.map((e) => e.name)).toEqual(['ok.txt']);
    expect(res.unreadable).toEqual([path.join(root, 'kaputt')]);
    expect(res.limitReached).toBe(false);
  });
});

describe('sanitising file names (edge cases)', () => {
  it('replaces every invalid character individually and collapses whitespace', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFileName('a/b\\c.txt')).toBe('b_c.txt'); // only "/" separates the path, the backslash is replaced
    expect(sanitizeFileName('viele   Leerzeichen\t\tund Tabs.txt')).toBe('viele Leerzeichen__und Tabs.txt'); // tabs are control characters and are replaced
    expect(sanitizeFileName('steuer\u0001zeichen.txt')).toBe('steuer_zeichen.txt');
  });

  it('removes leading dots as well as trailing dots and spaces', () => {
    expect(sanitizeFileName('..versteckt.txt')).toBe('versteckt.txt');
    expect(sanitizeFileName('name. . .txt')).toBe('name.txt');
    expect(sanitizeFileName('  Rand  .txt')).toBe('Rand.txt');
    expect(sanitizeFileName('. Bericht.txt')).toBe('Bericht.txt');
    expect(sanitizeFolderName('.. Ordner')).toBe('Ordner');
  });

  it('assigns the fallback name if nothing is left', () => {
    expect(sanitizeFileName('...')).toBe('Dokument');
    expect(sanitizeFileName('', 'Ordner')).toBe('Ordner');
    expect(sanitizeFileName('???.pdf')).toBe('___.pdf');
  });

  it('prefixes reserved Windows names with an underscore, but only on an exact match', () => {
    for (const reserved of ['con', 'PRN', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9']) expect(sanitizeFileName(`${reserved}.txt`)).toBe(`_${reserved}.txt`);
    for (const fine of ['console', 'xcon', 'conx', 'com0', 'lpt0', 'com10', 'nullable']) expect(sanitizeFileName(`${fine}.txt`)).toBe(`${fine}.txt`);
  });

  it('truncates the base name to 150 characters and never cuts a long suffix that is no extension', () => {
    expect(sanitizeFileName(`${'x'.repeat(150)}.txt`)).toBe(`${'x'.repeat(150)}.txt`);
    expect(sanitizeFileName(`${'x'.repeat(151)}.txt`)).toBe(`${'x'.repeat(150)}.txt`);
    expect(sanitizeFileName(`${'x'.repeat(300)}.txt`).length).toBe(154);
    expect(sanitizeFileName(`${'x'.repeat(149)} ${'y'.repeat(10)}.txt`)).toBe(`${'x'.repeat(149)}.txt`);
    expect(sanitizeFolderName(`${'x'.repeat(149)} ${'y'.repeat(10)}`)).toBe('x'.repeat(149));
    expect(sanitizeFileName('a.abcdefgh')).toBe('a.abcdefgh');
    expect(sanitizeFileName('a.abcdefghijk')).toBe('a.abcdefghijk');
  });

  it('lowercases and sanitises the extension and normalises Unicode (NFC)', () => {
    expect(sanitizeFileName('Bericht.PDF')).toBe('Bericht.pdf');
    expect(sanitizeFileName('Bericht.p?f')).toBe('Bericht.p_f');
    expect(sanitizeFileName('Cafe\u0301.txt')).toBe('Caf\u00e9.txt');
    expect(sanitizeFileName('ohne-endung')).toBe('ohne-endung');
  });
});

describe('resolving paths and sanitising categories (edge cases)', () => {
  it('rejects drive letters even without a backslash and explains why', () => {
    expect(() => resolveInside('/arch', 'C:foo')).toThrow(/Absolute Pfade/);
    expect(() => resolveInside('/arch', 'a\0b')).toThrow(/Nullbyte/);
    expect(() => resolveInside('/arch', 'a/../b')).toThrow(/verlässt/);
    expect(() => sanitizeCategoryPath('C:foo')).toThrow(/relativ/);
    expect(() => sanitizeCategoryPath('a\0b')).toThrow(/Ungültiger Ordnerpfad/);
  });

  it('accepts nested, doubled and reversed separators', () => {
    expect(resolveInside('/arch', 'a//b\\c')).toBe(path.resolve('/arch/a/b/c'));
    expect(resolveInside('/arch', '')).toBe(path.resolve('/arch'));
  });

  it('forbids "." and ".." as category segments and requires at least one segment', () => {
    expect(() => sanitizeCategoryPath('a/./b')).toThrow(/relative Pfadsegmente/);
    expect(() => sanitizeCategoryPath('a/../b')).toThrow(/relative Pfadsegmente/);
    expect(() => sanitizeCategoryPath('')).toThrow(/nicht leer/);
    expect(() => sanitizeCategoryPath(' / // ')).toThrow(/nicht leer/);
  });

  it('truncates categories to six levels, trims segments and sanitises each one individually', () => {
    expect(sanitizeCategoryPath('1/2/3/4/5/6/7/8')).toBe('1/2/3/4/5/6');
    expect(sanitizeCategoryPath('  work  /  projects\\Nordlicht ')).toBe('work/projects/Nordlicht');
    expect(sanitizeCategoryPath('ab:c/c*d')).toBe('ab_c/c_d');
    expect(sanitizeCategoryPath('con/v1.2')).toBe('_con/v1.2');
  });

  it('also resolves through non-existent folders and files as parent (ENOTDIR)', async () => {
    const file = path.join(tmp, 'datei.txt');
    fs.writeFileSync(file, 'x');

    expect(await realpathDeepest(path.join(file, 'unter', 'x'))).toBe(path.join(fs.realpathSync(file), 'unter', 'x'));
    expect(await realpathDeepest(path.join(tmp, 'gibt', 'es', 'nicht'))).toBe(path.join(fs.realpathSync(tmp), 'gibt', 'es', 'nicht'));
  });

  it('normalises paths without a trailing separator and leaves the root unchanged', () => {
    expect(normalizeFsPath('/a/b/')).toBe(path.resolve('/a/b'));
    expect(normalizeFsPath('/a/../a/b')).toBe(path.resolve('/a/b'));
    expect(normalizeFsPath('/')).toBe(path.resolve('/'));
  });

  it('creates missing parent folders and accepts an existing folder', () => {
    const nested = path.join(tmp, 'ensure', 'tief', 'unten');

    ensureDirSync(nested);
    ensureDirSync(nested);

    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });
});

describe('system directories as scan target (POSIX)', () => {
  const home = '/home/anna';
  const forbidden = (dir: string) => isForbiddenScanRoot(dir, { home, platform: 'linux' });

  it('forbids the root', () => {
    expect(forbidden('/')).toMatch(/Systemwurzeln/);
  });

  it('forbids every system directory and everything below it', () => {
    const system = [
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib32',
      '/lib64',
      '/dev',
      '/proc',
      '/sys',
      '/boot',
      '/var',
      '/run',
      '/srv',
      '/root',
      '/system',
      '/library',
      '/applications',
      '/private',
      '/volumes',
      '/home',
      '/users',
      '/opt',
      '/snap',
      '/tmp',
    ];
    for (const dir of system) {
      expect(forbidden(dir), dir).toMatch(/Systemverzeichnisse/);
      if (!['/volumes', '/tmp', '/private'].includes(dir)) expect(forbidden(`${dir}/unter`), `${dir}/unter`).toMatch(/Systemverzeichnisse/);
    }
  });

  it('ignores case for system directories', () => {
    expect(forbidden('/Etc')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/Library/Preferences')).toMatch(/Systemverzeichnisse/);
  });

  it('allows directories that merely start like a system directory', () => {
    for (const dir of ['/etcetera', '/binary', '/usr2', '/variable', '/daten/projekt']) expect(forbidden(dir), dir).toBeNull();
  });

  it("allows the own home directory including subfolders, but not the parent directory or other users' homes", () => {
    expect(forbidden('/home/anna')).toBeNull();
    expect(forbidden('/home/anna/Downloads')).toBeNull();
    expect(forbidden('/home')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/home/bert')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/home/annabel')).toMatch(/Systemverzeichnisse/);
  });

  it('allows temporary folders and mounted volumes, but not their root', () => {
    for (const dir of ['/tmp/x', '/var/tmp/x', '/var/folders/ab/cd', '/private/var/folders/ab', '/private/tmp/x', '/mnt/daten', '/Volumes/Extern'])
      expect(forbidden(dir), dir).toBeNull();
    // without a further folder they are no targets themselves: /mnt is not on the list, the others are
    for (const dir of ['/tmp', '/var/tmp', '/var/folders']) expect(forbidden(dir), dir).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/mnt')).toBeNull();
  });
});

describe('system directories as scan target (Windows)', () => {
  const home = 'C:\\Users\\Anna';
  const forbidden = (dir: string) => isForbiddenScanRoot(dir, { home, platform: 'win32' });

  it('forbids drive roots, also of other drives', () => {
    for (const dir of ['C:\\', 'c:/', 'D:\\']) expect(forbidden(dir), dir).toMatch(/Systemwurzeln/);
  });

  it('forbids every system directory and everything below it, regardless of case and separator', () => {
    for (const dir of [
      'C:\\Windows',
      'c:\\windows\\System32',
      'C:/Windows/Temp',
      'C:\\Program Files',
      'C:\\Program Files\\App',
      'C:\\Program Files (x86)',
      'C:\\PROGRAM FILES (X86)\\App',
      'C:\\ProgramData',
      'C:\\ProgramData\\Hersteller',
      'C:\\Users',
    ])
      expect(forbidden(dir), dir).toMatch(/Systemverzeichnisse/);
  });

  it('allows directories that merely start like a system directory and the same names on another drive', () => {
    for (const dir of ['C:\\WindowsFoo', 'C:\\Program Filesx', 'C:\\ProgramDataAlt', 'C:\\Users2', 'C:\\Daten', 'D:\\Windows', 'D:\\Users\\Bert'])
      expect(forbidden(dir), dir).toBeNull();
  });

  it("allows the own home directory including subfolders in any case, but not the parent or other users' homes", () => {
    expect(forbidden('C:\\Users\\Anna')).toBeNull();
    expect(forbidden('c:\\users\\anna\\Dokumente')).toBeNull();
    expect(forbidden('C:/Users/Anna/Downloads/')).toBeNull();
    expect(forbidden('C:\\Users')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('C:\\Users\\Bert')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('C:\\Users\\Annabel')).toMatch(/Systemverzeichnisse/);
  });
});

describe('path functions: error paths and edge cases', () => {
  it('rejects drive letters only at the start, not colons in the middle of the path', () => {
    expect(resolveInside('/arch', 'ordner/c:datei')).toBe(path.resolve('/arch/ordner/c:datei'));
    expect(sanitizeCategoryPath('ordner/c:datei')).toBe('ordner/c_datei');
  });

  it('keeps dots inside a name and removes only leading ones', () => {
    expect(sanitizeFileName('v1.2.3.txt')).toBe('v1.2.3.txt');
    expect(sanitizeFileName('a.b.c')).toBe('a.b.c');
    expect(sanitizeFileName('...v1.2.txt')).toBe('v1.2.txt');
  });

  it('passes on unexpected file system errors (ELOOP) instead of swallowing them', async () => {
    const a = path.join(tmp, 'schleife-a');
    const b = path.join(tmp, 'schleife-b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);

    await expect(realpathDeepest(path.join(a, 'x'))).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('uniquePath: unexpected errors (ENOTDIR) are passed on, only "does not exist" counts as free', async () => {
    const file = path.join(tmp, 'ist-eine-datei.txt');
    fs.writeFileSync(file, 'x');

    await expect(uniquePath(path.join(file, 'unterordner'), 'neu.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await uniquePath(tmp, 'gibt-es-nicht.txt')).toBe(path.join(tmp, 'gibt-es-nicht.txt'));
  });

  it('uniquePath gives up after 9999 taken names instead of looping on', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'voll-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    for (let attempt = 2; attempt < 10_000; attempt += 1) fs.writeFileSync(path.join(dir, `a (${attempt}).txt`), '');

    await expect(uniquePath(dir, 'a.txt')).rejects.toThrow('Kein freier Dateiname gefunden.');
  });

  it('uniquePath counts up while the name is taken', async () => {
    fs.writeFileSync(path.join(tmp, 'doppelt.txt'), 'x');
    fs.writeFileSync(path.join(tmp, 'doppelt (2).txt'), 'x');

    expect(await uniquePath(tmp, 'doppelt.txt')).toBe(path.join(tmp, 'doppelt (3).txt'));
  });
});

describe('names with ". " inside (issue #69)', () => {
  it('only treats a short alphanumeric suffix without spaces as the extension', () => {
    expect(splitExtension('Kunde Dr. Müller GmbH')).toEqual({ base: 'Kunde Dr. Müller GmbH', ext: '' });
    expect(splitExtension('St. Gallen')).toEqual({ base: 'St. Gallen', ext: '' });
    expect(splitExtension('St.Gallen')).toEqual({ base: 'St.Gallen', ext: '' });
    expect(splitExtension('Bericht.PDF')).toEqual({ base: 'Bericht', ext: 'PDF' });
    expect(splitExtension('archiv.tar.gz')).toEqual({ base: 'archiv.tar', ext: 'gz' });
    expect(splitExtension('.bashrc')).toEqual({ base: '.bashrc', ext: '' });
    expect(splitExtension('README')).toEqual({ base: 'README', ext: '' });
    expect(splitExtension('..pdf')).toEqual({ base: '..pdf', ext: '' });
    expect(splitExtension('...pdf')).toEqual({ base: '...pdf', ext: '' });
    expect(splitExtension('Rechnung. pdf')).toEqual({ base: 'Rechnung. pdf', ext: '' });
  });

  it('keeps file names with abbreviations readable', () => {
    expect(sanitizeFileName('Kunde Dr. Müller GmbH')).toBe('Kunde Dr. Müller GmbH');
    expect(sanitizeFileName('St. Gallen')).toBe('St. Gallen');
    expect(sanitizeFileName('Kunde Dr. Müller GmbH.PDF')).toBe('Kunde Dr. Müller GmbH.pdf');
    expect(sanitizeFileName('Angebot St. Gallen.docx')).toBe('Angebot St. Gallen.docx');
    expect(sanitizeFileName('Bericht.pdf ')).toBe('Bericht.pdf');
    expect(sanitizeFileName('Bericht.PDF ')).toBe('Bericht.pdf');
    expect(sanitizeFileName('Projekt X.Final')).toBe('Projekt X.Final');
  });

  it('never splits an extension off folder segments', () => {
    expect(sanitizeFolderName('Kunde Dr. Müller GmbH')).toBe('Kunde Dr. Müller GmbH');
    expect(sanitizeFolderName('Version 1.PDF')).toBe('Version 1.PDF');
    expect(sanitizeFolderName('  ')).toBe('Ordner');
    expect(sanitizeCategoryPath('work/Kunde Dr. Müller GmbH/St. Gallen')).toBe('work/Kunde Dr. Müller GmbH/St. Gallen');
    expect(sanitizeCategoryPath('kunden/St.Gallen.Archiv')).toBe('kunden/St.Gallen.Archiv');
  });

  it('prefixes reserved device names even when followed by more dots', () => {
    expect(sanitizeFileName('con.tar.gz')).toBe('_con.tar.gz');
    expect(sanitizeFolderName('aux.alt')).toBe('_aux.alt');
    expect(sanitizeFolderName('auxiliar')).toBe('auxiliar');
  });
});

describe('isWithinCategoryFolder (#244)', () => {
  it('matches whole segments only, case-insensitively', () => {
    expect(isWithinCategoryFolder('Work/Sub', 'work/sub')).toBe(true);
    expect(isWithinCategoryFolder('work/sub/deeper', 'work/sub')).toBe(true);
    expect(isWithinCategoryFolder('work/sub2', 'work/sub')).toBe(false);
    expect(isWithinCategoryFolder('work', 'work/sub')).toBe(false);
    expect(isWithinCategoryFolder('work\\sub', 'work/sub')).toBe(true);
  });
});
