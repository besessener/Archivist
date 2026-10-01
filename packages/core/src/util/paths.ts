import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { permissionError, validationError } from './errors';

const SEP_RE = /[\\/]/;

/** true, wenn `candidate` gleich `root` ist oder darunter liegt (rein lexikalisch, nach Normalisierung). */
/** Zulassungsliste: temporäre Ordner sind absichtlich als Scan-Ziel erlaubt (Tests, Wegwerf-Ordner). */
// eslint-disable-next-line sonarjs/publicly-writable-directories -- keine Nutzung als Ablageort, nur Vergleich von Pfadpräfixen
const TEMP_PREFIXES = ['/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/', '/private/tmp/'];

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** Löst einen relativen Pfad strikt innerhalb von `root` auf (kein Path Traversal, keine absoluten Pfade). */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw validationError('Ungültiger Pfad (Nullbyte).');
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw permissionError('Absolute Pfade sind hier nicht erlaubt.', rel);
  const parts = rel.split(SEP_RE).filter((p) => p !== '');
  if (parts.some((p) => p === '..')) throw permissionError('Pfad verlässt den erlaubten Bereich (..).', rel);
  const abs = path.resolve(root, ...parts);
  if (!isInside(root, abs)) throw permissionError('Pfad liegt außerhalb des erlaubten Bereichs.', rel);
  return abs;
}

/** realpath des tiefsten existierenden Vorfahren + nicht existierender Rest. */
export async function realpathDeepest(target: string): Promise<string> {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return path.join(real, ...rest.toReversed());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest.toReversed());
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Prüft zusätzlich zur lexikalischen Prüfung, dass kein Symlink aus `root` herausführt.
 * Gibt den aufgelösten realen Pfad zurück.
 */
export async function assertRealInside(root: string, target: string): Promise<string> {
  const realRoot = await fsp.realpath(root);
  const realTarget = await realpathDeepest(target);
  if (!isInside(realRoot, realTarget)) {
    throw permissionError('Pfad führt (z. B. über einen symbolischen Link) aus dem erlaubten Bereich heraus.', target);
  }
  return realTarget;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Macht einen einzelnen Dateinamen plattformübergreifend gültig und menschenlesbar. */
export function sanitizeFileName(name: string, fallback = 'Dokument'): string {
  const ext = path.extname(name);
  let base = path.basename(name, ext);
  const clean = (s: string) =>
    s
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      // eslint-disable-next-line sonarjs/super-linear-regex -- Dateiname, höchstens 255 Zeichen
      .replace(/[. ]+$/g, '')
      .trim();
  base = clean(base);
  let cleanExt = clean(ext.replace(/^\./, '')).toLowerCase();
  if (cleanExt.length > 10) cleanExt = cleanExt.slice(0, 10);
  if (!base) base = fallback;
  if (RESERVED.test(base)) base = `_${base}`;
  if (base.length > 150) base = base.slice(0, 150).trim();
  return cleanExt ? `${base}.${cleanExt}` : base;
}

/** Bereinigt einen relativen Kategoriepfad (z. B. "work/projects/prod-plat"); wirft bei Traversal. */
export function sanitizeCategoryPath(input: string): string {
  if (input.includes('\0')) throw validationError('Ungültiger Ordnerpfad.');
  if (path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) throw permissionError('Der Zielordner muss relativ zum Archiv sein.', input);
  const segs = input
    .split(SEP_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) throw permissionError('Ungültiger Zielordner (relative Pfadsegmente).', input);
  const clean = segs.map((s) => sanitizeFileName(s, 'Ordner').replace(/\.[a-z0-9]{1,10}$/i, (m) => m)).slice(0, 6);
  if (clean.length === 0) throw validationError('Der Zielordner darf nicht leer sein.');
  return clean.join('/');
}

/** Systemverzeichnisse und Wurzeln, die nie als Scan-Verzeichnis freigegeben werden dürfen. */
export function isForbiddenScanRoot(dir: string, opts: { home?: string; username?: string } = {}): string | null {
  const resolved = path.resolve(dir);
  const home = path.resolve(opts.home ?? os.homedir());
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(resolved);
  if (path.dirname(resolved) === resolved) return 'Laufwerks- oder Systemwurzeln dürfen nicht gescannt werden.';
  const posixSystem = [
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
  if (process.platform !== 'win32') {
    const lower = r.toLowerCase();
    for (const sys of posixSystem) {
      if (lower === sys || lower.startsWith(`${sys}/`)) {
        // Unterhalb des eigenen Home-Verzeichnisses ist alles erlaubt (z. B. /home/me/Downloads)
        if (isInside(home, resolved) && resolved !== path.dirname(home)) return null;
        // /tmp und /var/tmp sind für Tests/temporäre Ordner zulässig, sofern nicht Wurzel
        if (TEMP_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
        if (lower.startsWith('/volumes/') || lower.startsWith('/mnt/')) return null;
        return 'Systemverzeichnisse oder Verzeichnisse anderer Benutzer dürfen nicht gescannt werden.';
      }
    }
  } else {
    const windows = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', 'c:\\users'];
    for (const sys of windows) {
      if (r === sys || r.startsWith(`${sys}\\`)) {
        if (isInside(home, resolved) && norm(resolved) !== norm(path.dirname(home))) return null;
        return 'Systemverzeichnisse oder Verzeichnisse anderer Benutzer dürfen nicht gescannt werden.';
      }
    }
  }
  return null;
}

/** Normalisiert einen Pfad für Vergleiche und Speicherung (absolut, ohne trailing separator). */
export function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Ermittelt einen freien Dateinamen "Name.ext" → "Name (2).ext" … ohne etwas zu überschreiben. */
export async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = path.join(dir, i === 1 ? fileName : `${base} (${i})${ext}`);
    try {
      await fsp.lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw err;
    }
  }
  throw validationError('Kein freier Dateiname gefunden.');
}
