import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertRealInside,
  isForbiddenScanRoot,
  isInside,
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

  it('beachtet "nicht rekursiv" und Datei-Ausschlüsse', async () => {
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
});

describe('Dateinamen bereinigen (Grenzfälle)', () => {
  it('ersetzt jedes unzulässige Zeichen einzeln und fasst Leerraum zusammen', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFileName('a/b\\c.txt')).toBe('b_c.txt'); // nur "/" trennt den Pfad, der Backslash wird ersetzt
    expect(sanitizeFileName('viele   Leerzeichen\t\tund Tabs.txt')).toBe('viele Leerzeichen__und Tabs.txt'); // Tabs sind Steuerzeichen und werden ersetzt
    expect(sanitizeFileName('steuer\u0001zeichen.txt')).toBe('steuer_zeichen.txt');
  });

  it('entfernt führende Punkte sowie Punkte und Leerzeichen am Ende', () => {
    expect(sanitizeFileName('..versteckt.txt')).toBe('versteckt.txt');
    expect(sanitizeFileName('name. . .txt')).toBe('name.txt');
    expect(sanitizeFileName('  Rand  .txt')).toBe('Rand.txt');
  });

  it('vergibt den Ersatznamen, wenn nichts übrig bleibt', () => {
    expect(sanitizeFileName('...')).toBe('Dokument');
    expect(sanitizeFileName('', 'Ordner')).toBe('Ordner');
    expect(sanitizeFileName('???.pdf')).toBe('___.pdf');
  });

  it('stellt reservierten Windows-Namen einen Unterstrich voran, aber nur bei genauem Treffer', () => {
    for (const reserved of ['con', 'PRN', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9']) expect(sanitizeFileName(`${reserved}.txt`)).toBe(`_${reserved}.txt`);
    for (const fine of ['console', 'xcon', 'conx', 'com0', 'lpt0', 'com10', 'nullable']) expect(sanitizeFileName(`${fine}.txt`)).toBe(`${fine}.txt`);
  });

  it('truncates the base name to 150 characters and never cuts a long suffix that is no extension', () => {
    expect(sanitizeFileName(`${'x'.repeat(150)}.txt`)).toBe(`${'x'.repeat(150)}.txt`);
    expect(sanitizeFileName(`${'x'.repeat(151)}.txt`)).toBe(`${'x'.repeat(150)}.txt`);
    expect(sanitizeFileName(`${'x'.repeat(300)}.txt`).length).toBe(154);
    expect(sanitizeFileName('a.abcdefgh')).toBe('a.abcdefgh');
    expect(sanitizeFileName('a.abcdefghijk')).toBe('a.abcdefghijk');
  });

  it('schreibt die Endung klein, bereinigt sie und normalisiert Unicode (NFC)', () => {
    expect(sanitizeFileName('Bericht.PDF')).toBe('Bericht.pdf');
    expect(sanitizeFileName('Bericht.p?f')).toBe('Bericht.p_f');
    expect(sanitizeFileName('Cafe\u0301.txt')).toBe('Caf\u00e9.txt');
    expect(sanitizeFileName('ohne-endung')).toBe('ohne-endung');
  });
});

describe('Pfade auflösen und Kategorien bereinigen (Grenzfälle)', () => {
  it('lehnt Laufwerksangaben auch ohne Backslash ab und erklärt warum', () => {
    expect(() => resolveInside('/arch', 'C:foo')).toThrow(/Absolute Pfade/);
    expect(() => resolveInside('/arch', 'a\0b')).toThrow(/Nullbyte/);
    expect(() => resolveInside('/arch', 'a/../b')).toThrow(/verlässt/);
    expect(() => sanitizeCategoryPath('C:foo')).toThrow(/relativ/);
    expect(() => sanitizeCategoryPath('a\0b')).toThrow(/Ungültiger Ordnerpfad/);
  });

  it('akzeptiert verschachtelte, doppelte und umgekehrte Trennzeichen', () => {
    expect(resolveInside('/arch', 'a//b\\c')).toBe(path.resolve('/arch/a/b/c'));
    expect(resolveInside('/arch', '')).toBe(path.resolve('/arch'));
  });

  it('verbietet "." und ".." als Kategoriesegment und verlangt mindestens ein Segment', () => {
    expect(() => sanitizeCategoryPath('a/./b')).toThrow(/relative Pfadsegmente/);
    expect(() => sanitizeCategoryPath('a/../b')).toThrow(/relative Pfadsegmente/);
    expect(() => sanitizeCategoryPath('')).toThrow(/nicht leer/);
    expect(() => sanitizeCategoryPath(' / // ')).toThrow(/nicht leer/);
  });

  it('kürzt Kategorien auf sechs Ebenen, trimmt Segmente und bereinigt jedes einzeln', () => {
    expect(sanitizeCategoryPath('1/2/3/4/5/6/7/8')).toBe('1/2/3/4/5/6');
    expect(sanitizeCategoryPath('  work  /  projects\\Nordlicht ')).toBe('work/projects/Nordlicht');
    expect(sanitizeCategoryPath('ab:c/c*d')).toBe('ab_c/c_d');
    expect(sanitizeCategoryPath('con/v1.2')).toBe('_con/v1.2');
  });

  it('löst auch über nicht existierende Ordner und Dateien als Elternteil auf (ENOTDIR)', async () => {
    const file = path.join(tmp, 'datei.txt');
    fs.writeFileSync(file, 'x');

    expect(await realpathDeepest(path.join(file, 'unter', 'x'))).toBe(path.join(fs.realpathSync(file), 'unter', 'x'));
    expect(await realpathDeepest(path.join(tmp, 'gibt', 'es', 'nicht'))).toBe(path.join(fs.realpathSync(tmp), 'gibt', 'es', 'nicht'));
  });

  it('normalisiert Pfade ohne abschließenden Trenner und lässt die Wurzel unverändert', () => {
    expect(normalizeFsPath('/a/b/')).toBe(path.resolve('/a/b'));
    expect(normalizeFsPath('/a/../a/b')).toBe(path.resolve('/a/b'));
    expect(normalizeFsPath('/')).toBe(path.resolve('/'));
  });
});

describe.skipIf(process.platform === 'win32')('Systemverzeichnisse als Scan-Ziel (POSIX)', () => {
  const home = '/home/anna';
  const forbidden = (dir: string) => isForbiddenScanRoot(dir, { home });

  it('verbietet die Wurzel', () => {
    expect(forbidden('/')).toMatch(/Systemwurzeln/);
  });

  it('verbietet jedes Systemverzeichnis und alles darunter', () => {
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

  it('ignoriert die Groß-/Kleinschreibung bei Systemverzeichnissen', () => {
    expect(forbidden('/Etc')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/Library/Preferences')).toMatch(/Systemverzeichnisse/);
  });

  it('erlaubt Verzeichnisse, die nur so beginnen wie ein Systemverzeichnis', () => {
    for (const dir of ['/etcetera', '/binary', '/usr2', '/variable', '/daten/projekt']) expect(forbidden(dir), dir).toBeNull();
  });

  it('erlaubt das eigene Home-Verzeichnis samt Unterordnern, nicht aber das Elternverzeichnis oder fremde Homes', () => {
    expect(forbidden('/home/anna')).toBeNull();
    expect(forbidden('/home/anna/Downloads')).toBeNull();
    expect(forbidden('/home')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/home/bert')).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/home/annabel')).toMatch(/Systemverzeichnisse/);
  });

  it('erlaubt temporäre Ordner und eingehängte Datenträger, aber nicht deren Wurzel', () => {
    for (const dir of ['/tmp/x', '/var/tmp/x', '/var/folders/ab/cd', '/private/var/folders/ab', '/private/tmp/x', '/mnt/daten', '/Volumes/Extern'])
      expect(forbidden(dir), dir).toBeNull();
    // ohne weiteren Ordner sind sie selbst keine Ziele: /mnt steht nicht auf der Liste, die anderen schon
    for (const dir of ['/tmp', '/var/tmp', '/var/folders']) expect(forbidden(dir), dir).toMatch(/Systemverzeichnisse/);
    expect(forbidden('/mnt')).toBeNull();
  });
});

describe('Pfadfunktionen: Fehlerpfade und Randfälle', () => {
  it('lehnt nur Laufwerksangaben am Anfang ab, nicht Doppelpunkte mitten im Pfad', () => {
    expect(resolveInside('/arch', 'ordner/c:datei')).toBe(path.resolve('/arch/ordner/c:datei'));
    expect(sanitizeCategoryPath('ordner/c:datei')).toBe('ordner/c_datei');
  });

  it('behält Punkte innerhalb eines Namens und entfernt nur führende', () => {
    expect(sanitizeFileName('v1.2.3.txt')).toBe('v1.2.3.txt');
    expect(sanitizeFileName('a.b.c')).toBe('a.b.c');
    expect(sanitizeFileName('...v1.2.txt')).toBe('v1.2.txt');
  });

  it('reicht unerwartete Dateisystemfehler weiter (ELOOP) statt sie zu verschlucken', async () => {
    const a = path.join(tmp, 'schleife-a');
    const b = path.join(tmp, 'schleife-b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);

    await expect(realpathDeepest(path.join(a, 'x'))).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('uniquePath: unerwartete Fehler (ENOTDIR) werden weitergereicht, nur "nicht vorhanden" gilt als frei', async () => {
    const file = path.join(tmp, 'ist-eine-datei.txt');
    fs.writeFileSync(file, 'x');

    await expect(uniquePath(path.join(file, 'unterordner'), 'neu.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await uniquePath(tmp, 'gibt-es-nicht.txt')).toBe(path.join(tmp, 'gibt-es-nicht.txt'));
  });

  it('uniquePath zählt hoch, solange der Name belegt ist', async () => {
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
    expect(splitExtension('Rechnung. pdf')).toEqual({ base: 'Rechnung. pdf', ext: '' });
  });

  it('keeps file names with abbreviations readable', () => {
    expect(sanitizeFileName('Kunde Dr. Müller GmbH')).toBe('Kunde Dr. Müller GmbH');
    expect(sanitizeFileName('St. Gallen')).toBe('St. Gallen');
    expect(sanitizeFileName('Kunde Dr. Müller GmbH.PDF')).toBe('Kunde Dr. Müller GmbH.pdf');
    expect(sanitizeFileName('Angebot St. Gallen.docx')).toBe('Angebot St. Gallen.docx');
    expect(sanitizeFileName('Bericht.pdf ')).toBe('Bericht.pdf');
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
