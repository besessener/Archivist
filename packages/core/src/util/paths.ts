import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { permissionError, validationError } from './errors';

const SEP_RE = /[\\/]/;

/** Allowlist: temporary folders are intentionally allowed as scan targets (tests, throwaway folders). */
// eslint-disable-next-line sonarjs/publicly-writable-directories -- not used as a storage location, only to compare path prefixes
const TEMP_PREFIXES = ['/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/', '/private/tmp/'];

/** true if `candidate` equals `root` or lies below it (purely lexical, after normalization). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** Resolves a relative path strictly inside `root` (no path traversal, no absolute paths). */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw validationError('Ungültiger Pfad (Nullbyte).');
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw permissionError('Absolute Pfade sind hier nicht erlaubt.', rel);
  const parts = rel.split(SEP_RE).filter((p) => p !== '');
  if (parts.some((p) => p === '..')) throw permissionError('Pfad verlässt den erlaubten Bereich (..).', rel);
  const abs = path.resolve(root, ...parts);
  if (!isInside(root, abs)) throw permissionError('Pfad liegt außerhalb des erlaubten Bereichs.', rel);
  return abs;
}

/** realpath of the deepest existing ancestor + the non-existing rest. */
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
 * In addition to the lexical check, verifies that no symlink leads out of `root`.
 * Returns the resolved real path.
 */
export async function assertRealInside(root: string, target: string): Promise<string> {
  const realRoot = await fsp.realpath(root);
  const realTarget = await realpathDeepest(target);
  if (!isInside(realRoot, realTarget)) {
    throw permissionError('Pfad führt (z. B. über einen symbolischen Link) aus dem erlaubten Bereich heraus.', target);
  }
  return realTarget;
}

/** Windows reserves these device names, also when followed by an extension ("CON.txt", "con.tar.gz"). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Only a short alphanumeric suffix without spaces counts as a file extension. Mixed case ("St.Gallen") is
 * treated as part of the name, so it is neither lowercased nor cut; "PDF" or "pdf" are extensions.
 */
const EXTENSION_RE = /^(?:[a-z0-9]{1,8}|[A-Z0-9]{1,8})$/;

/** Splits a name into base and extension (without the dot); `ext` is '' when the suffix is no real extension. */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' };
  const ext = name.slice(dot + 1);
  if (!EXTENSION_RE.test(ext) || name.slice(0, dot).replace(/^\.+/, '') === '') return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext };
}

const cleanNamePart = (s: string) =>
  s
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    // eslint-disable-next-line sonarjs/super-linear-regex -- file name, at most 255 characters
    .replace(/[. ]+$/g, '')
    .trim();

function finishBase(base: string, fallback: string): string {
  let out = base || fallback;
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > 150) out = out.slice(0, 150).trim();
  return out;
}

/** Makes a single file name valid across platforms and human-readable. */
export function sanitizeFileName(name: string, fallback = 'Dokument'): string {
  const { base, ext } = splitExtension(path.basename(name).trimEnd());
  const cleanExt = ext.toLowerCase();
  const cleanBase = finishBase(cleanNamePart(base), fallback);
  return cleanExt ? `${cleanBase}.${cleanExt}` : cleanBase;
}

/** Sanitises a single folder segment: folders have no extension, so dots inside the name stay untouched. */
export function sanitizeFolderName(name: string, fallback = 'Ordner'): string {
  return finishBase(cleanNamePart(name), fallback);
}

/** Cleans a relative category path (e.g. "work/projects/prod-plat"); throws on traversal. */
export function sanitizeCategoryPath(input: string): string {
  if (input.includes('\0')) throw validationError('Ungültiger Ordnerpfad.');
  if (path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) throw permissionError('Der Zielordner muss relativ zum Archiv sein.', input);
  const segs = input
    .split(SEP_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) throw permissionError('Ungültiger Zielordner (relative Pfadsegmente).', input);
  const clean = segs.map((s) => sanitizeFolderName(s)).slice(0, 6);
  if (clean.length === 0) throw validationError('Der Zielordner darf nicht leer sein.');
  return clean.join('/');
}

/** System directories and roots that may never be approved as a scan directory. */
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
        // everything below the user's own home directory is allowed (e.g. /home/me/Downloads)
        if (isInside(home, resolved) && resolved !== path.dirname(home)) return null;
        // /tmp and /var/tmp are allowed for tests/temporary folders, unless they are the root itself
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

/** Normalizes a path for comparison and storage (absolute, without trailing separator). */
export function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Finds a free file name "Name.ext" → "Name (2).ext" … without overwriting anything. */
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
