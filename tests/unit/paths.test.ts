import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRealInside, isForbiddenScanRoot, isInside, resolveInside, sanitizeCategoryPath, sanitizeFileName, uniquePath } from '../../packages/core/src/util/paths';
import { scanDirectory } from '../../packages/core/src/workers/tasks';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-paths-'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Pfadnormalisierung und Path-Traversal-Schutz', () => {
  it('erkennt Pfade innerhalb eines Wurzelverzeichnisses', () => {
    expect(isInside('/a/b', '/a/b/c/d.txt')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
    expect(isInside('/a/b', '/a/b/..foo/x')).toBe(true);
  });

  it('lehnt Traversal, absolute Pfade und Nullbytes ab', () => {
    expect(() => resolveInside('/arch', '../etc/passwd')).toThrow();
    expect(() => resolveInside('/arch', 'work/../../x')).toThrow();
    expect(() => resolveInside('/arch', '/etc/passwd')).toThrow();
    expect(() => resolveInside('/arch', 'C:\\Windows')).toThrow();
    expect(() => resolveInside('/arch', 'a\0b')).toThrow();
    expect(resolveInside('/arch', 'work/projects/x')).toBe(path.resolve('/arch/work/projects/x'));
  });

  it('bereinigt Kategoriepfade und verbietet relative Segmente', () => {
    expect(sanitizeCategoryPath('work\\projects//prod-plat/')).toBe('work/projects/prod-plat');
    expect(() => sanitizeCategoryPath('work/../../etc')).toThrow();
    expect(() => sanitizeCategoryPath('/abs')).toThrow();
    expect(() => sanitizeCategoryPath('   ')).toThrow();
  });

  it('macht Dateinamen plattformübergreifend gültig', () => {
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('  ..hidden. ')).toBe('hidden');
    expect(sanitizeFileName('')).toBe('Dokument');
    expect(sanitizeFileName('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(160);
  });

  it('vergibt freie Dateinamen statt zu überschreiben', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'u-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    fs.writeFileSync(path.join(dir, 'a (2).txt'), '2');
    expect(path.basename(await uniquePath(dir, 'a.txt'))).toBe('a (3).txt');
  });

  it('verbietet Systemverzeichnisse und Wurzeln als Scan-Verzeichnis', () => {
    expect(isForbiddenScanRoot('/')).toBeTruthy();
    expect(isForbiddenScanRoot('/etc')).toBeTruthy();
    expect(isForbiddenScanRoot('/usr/share')).toBeTruthy();
    expect(isForbiddenScanRoot('/home/other/Documents', { home: '/home/me' })).toBeTruthy();
    expect(isForbiddenScanRoot('/home/me/Downloads', { home: '/home/me' })).toBeNull();
  });
});

describe('Symlink-Ausbruch und Scan-Bereichsbegrenzung', () => {
  it('erkennt Symlinks, die aus dem Bereich herausführen', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    await expect(assertRealInside(root, path.join(root, 'link', 'x.txt'))).rejects.toThrow(/außerhalb|heraus/i);
    await expect(assertRealInside(root, path.join(root, 'neu', 'x.txt'))).resolves.toBeTruthy();
  });

  it('scannt nur innerhalb des freigegebenen Bereichs und folgt keinen ausbrechenden Links', async () => {
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
    const res = await scanDirectory({ root, recursive: true, excludedDirs: [path.join(root, 'skipme')], excludedFiles: [], extensions: ['txt', 'md'], maxSizeBytes: 1000 });
    const names = res.entries.map((e) => path.relative(root, e.path)).sort();
    expect(names).toEqual(['ok.txt', path.join('sub', 'tief.md')]);
    expect(res.skipped.some((s) => s.path.endsWith('file-escape.txt'))).toBe(true);
    expect(res.skipped.some((s) => s.reason.includes('maximale Größe'))).toBe(true);
  });

  it('beachtet "nicht rekursiv" und Datei-Ausschlüsse', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'flat-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b');
    fs.mkdirSync(path.join(root, 'd'));
    fs.writeFileSync(path.join(root, 'd', 'c.txt'), 'c');
    const res = await scanDirectory({ root, recursive: false, excludedDirs: [], excludedFiles: [path.join(root, 'b.txt')], extensions: ['txt'], maxSizeBytes: 1e6 });
    expect(res.entries.map((e) => e.name)).toEqual(['a.txt']);
  });
});
