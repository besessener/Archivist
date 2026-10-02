import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { permissionError, validationError } from './errors';

const SEPARATOR = /[\\/]/;

/** Allowlist: temporary folders are intentionally allowed as scan targets (tests, throwaway folders). */
// eslint-disable-next-line sonarjs/publicly-writable-directories -- not used as a storage location, only to compare path prefixes
const TEMP_PREFIXES = ['/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/', '/private/tmp/'];

/** true if `candidate` equals `root` or lies below it (purely lexical, after normalization). */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/** Resolves a relative path strictly inside `root` (no path traversal, no absolute paths). */
export function resolveInside(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) throw validationError('Ungültiger Pfad (Nullbyte).');
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) throw permissionError('Absolute Pfade sind hier nicht erlaubt.', relativePath);
  const parts = relativePath.split(SEPARATOR).filter((part) => part !== '');
  if (parts.some((part) => part === '..')) throw permissionError('Pfad verlässt den erlaubten Bereich (..).', relativePath);
  const absolute = path.resolve(root, ...parts);
  if (!isInside(root, absolute)) throw permissionError('Pfad liegt außerhalb des erlaubten Bereichs.', relativePath);
  return absolute;
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

/** Like `isInside`, but also rejects a symlink leading out of `root`; returns the resolved real path. */
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

/** An extension is a short alphanumeric suffix in one case ("pdf", "PDF"); mixed case ("St.Gallen") belongs to the name. */
const EXTENSION_RE = /^(?:[a-z0-9]{1,8}|[A-Z0-9]{1,8})$/;

/** Splits a name into base and extension (without the dot); `ext` is '' when the suffix is no real extension. */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' };
  const ext = name.slice(dot + 1);
  if (!EXTENSION_RE.test(ext) || name.slice(0, dot).replace(/^\.+/, '') === '') return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext };
}

const cleanNamePart = (part: string) =>
  part
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are invalid in file names and get replaced
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    // eslint-disable-next-line sonarjs/super-linear-regex -- file name, at most 255 characters
    .replace(/[. ]+$/g, '')
    .trim();

function finishBase(base: string, fallback: string): string {
  let name = base || fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 150) name = name.slice(0, 150).trim();
  return name;
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
  const segments = input
    .split(SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) throw permissionError('Ungültiger Zielordner (relative Pfadsegmente).', input);
  const cleaned = segments.map((segment) => sanitizeFolderName(segment)).slice(0, 6);
  if (cleaned.length === 0) throw validationError('Der Zielordner darf nicht leer sein.');
  return cleaned.join('/');
}

const POSIX_SYSTEM_DIRS = [
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
const WINDOWS_SYSTEM_DIRS = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', 'c:\\users'];
const SYSTEM_DIR_REASON = 'Systemverzeichnisse oder Verzeichnisse anderer Benutzer dürfen nicht gescannt werden.';

function posixForbiddenReason(resolved: string, home: string): string | null {
  const lower = resolved.toLowerCase();
  if (!POSIX_SYSTEM_DIRS.some((sys) => lower === sys || lower.startsWith(`${sys}/`))) return null;
  // everything below the user's own home directory is allowed (e.g. /home/me/Downloads)
  if (isInside(home, resolved) && resolved !== path.dirname(home)) return null;
  // /tmp and /var/tmp are allowed for tests/temporary folders, unless they are the root itself
  if (TEMP_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
  if (lower.startsWith('/volumes/') || lower.startsWith('/mnt/')) return null;
  return SYSTEM_DIR_REASON;
}

function windowsForbiddenReason(resolved: string, home: string): string | null {
  const lower = resolved.toLowerCase();
  if (!WINDOWS_SYSTEM_DIRS.some((sys) => lower === sys || lower.startsWith(`${sys}\\`))) return null;
  if (isInside(home, resolved) && lower !== path.dirname(home).toLowerCase()) return null;
  return SYSTEM_DIR_REASON;
}

/** System directories and roots that may never be approved as a scan directory. */
export function isForbiddenScanRoot(dir: string, opts: { home?: string; username?: string } = {}): string | null {
  const resolved = path.resolve(dir);
  const home = path.resolve(opts.home ?? os.homedir());
  if (path.dirname(resolved) === resolved) return 'Laufwerks- oder Systemwurzeln dürfen nicht gescannt werden.';
  return process.platform === 'win32' ? windowsForbiddenReason(resolved, home) : posixForbiddenReason(resolved, home);
}

/** Normalizes a path for comparison and storage (absolute, without trailing separator). */
export function normalizeFsPath(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Finds a free file name "Name.ext" → "Name (2).ext" … without overwriting anything. */
export async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = path.join(dir, attempt === 1 ? fileName : `${base} (${attempt})${ext}`);
    try {
      await fsp.lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw err;
    }
  }
  throw validationError('Kein freier Dateiname gefunden.');
}
