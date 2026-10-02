import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveRootPresence } from '@archivist/shared';
import { isInside } from '../util/paths';

const MAX_EXAMPLES = 5;

export interface ArchivedDoc {
  id: string;
  title: string;
  rel: string;
  size: number;
  sha256: string;
}

interface TreeFile {
  rel: string;
  size: number;
}

/** Old and new archive root of a change. */
export interface RootRoute {
  from: string;
  to: string;
}

export interface MigratePlan {
  files: TreeFile[];
  dirs: string[];
  alreadyPresent: number;
  blockers: string[];
}

export const toAbs = (root: string, rel: string) => path.join(root, ...rel.split('/'));
export const exists = (p: string) => fs.existsSync(p);

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** German list of the first examples, with “… und N weitere” for the rest. */
export function exampleList(items: string[]): string {
  const shown = items.slice(0, MAX_EXAMPLES).map((t) => `„${t}“`);
  return items.length > MAX_EXAMPLES ? `${shown.join(', ')} und ${items.length - MAX_EXAMPLES} weitere` : shown.join(', ');
}

/** “1 Dokument liegt” / “2 Dokumente liegen”: noun phrase plus the verb in singular or plural. */
export const documentsPhrase = (n: number, verb: { singular: string; plural: string }) =>
  n === 1 ? `1 Dokument ${verb.singular}` : `${n} Dokumente ${verb.plural}`;
export const archivedDocsText = (n: number) => (n === 1 ? '1 archiviertes Dokument' : `${n} archivierte Dokumente`);

/** Nearest existing ancestor of `p` (or `p` itself). */
function existingAncestor(p: string): string {
  let current = path.resolve(p);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function samePath(a: string, b: string): boolean {
  const normalized = (p: string) => {
    const resolved = path.resolve(p);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  const [x, y] = [normalized(a), normalized(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Why the new folder cannot take the archive: not a folder or not writable. */
export function writableBlockers(to: string): string[] {
  const ancestor = existingAncestor(to);
  try {
    if (!fs.statSync(ancestor).isDirectory()) return [`„${ancestor}“ ist kein Ordner.`];
    fs.accessSync(ancestor, fs.constants.W_OK);
  } catch {
    return ['Der neue Ordner ist nicht beschreibbar.'];
  }
  return [];
}

/** Size of a file, -1 for something else, null when missing. */
function sizeAt(p: string): number | null {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return null;
  }
}

/** Checks (by existence and size) whether the archived documents are found under `root`. */
export function presenceOf(root: string, docs: ArchivedDoc[]): ArchiveRootPresence {
  const out: ArchiveRootPresence = { documents: docs.length, present: 0, missing: 0, different: 0, examples: [] };
  for (const d of docs) {
    const size = sizeAt(toAbs(root, d.rel));
    if (size === d.size) {
      out.present += 1;
      continue;
    }
    if (size === null) out.missing += 1;
    else out.different += 1;
    if (out.examples.length < MAX_EXAMPLES) out.examples.push(d.title);
  }
  return out;
}

/** All regular files below `from` (symlinks are not followed), plus the directories (relative POSIX paths). */
async function listTree(from: string, excluded: string[]): Promise<{ files: TreeFile[]; dirs: string[] }> {
  const files: TreeFile[] = [];
  const dirs: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (excluded.some((x) => isInside(x, full))) continue;
      if (entry.isDirectory()) {
        dirs.push(childRel);
        await walk(full, childRel);
      } else if (entry.isFile()) files.push({ rel: childRel, size: (await fsp.stat(full)).size });
    }
  };
  await walk(from, '');
  return { files, dirs };
}

function locationBlockers({ from, to }: RootRoute): string[] {
  if (!exists(from)) return ['Der bisherige Archivordner existiert nicht mehr – es gibt nichts umzuziehen.'];
  if (isInside(from, to)) return ['Der neue Ordner liegt innerhalb des bisherigen Archivordners.'];
  if (isInside(to, from)) return ['Der bisherige Archivordner liegt innerhalb des neuen Ordners.'];
  return [];
}

function freeSpaceBlockers(to: string, bytesToCopy: number): string[] {
  try {
    const stat = fs.statfsSync(existingAncestor(to));
    const free = stat.bavail * stat.bsize;
    if (free < bytesToCopy) return [`Am neuen Ort ist nicht genug Speicherplatz frei (benötigt ${formatMb(bytesToCopy)}, frei ${formatMb(free)}).`];
  } catch {
    // free space unknown: the copy itself reports a full disk
  }
  return [];
}

/** The files a move would copy, those already in place, and what prevents the move (never overwrites anything). */
export async function planCopy(route: RootRoute, excluded: string[]): Promise<MigratePlan> {
  const blockers = locationBlockers(route);
  if (blockers.length) return { files: [], dirs: [], alreadyPresent: 0, blockers };
  const { files, dirs } = await listTree(route.from, excluded);
  let alreadyPresent = 0;
  let bytesToCopy = 0;
  const taken: string[] = [];
  for (const f of files) {
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(toAbs(route.to, f.rel));
    } catch {
      stat = null;
    }
    if (!stat) bytesToCopy += f.size;
    else if (stat.isFile() && stat.size === f.size) alreadyPresent += 1;
    else taken.push(f.rel);
  }
  if (taken.length) blockers.push(`Im neuen Ordner liegen bereits andere Dateien unter denselben Namen: ${exampleList(taken)}. Archivist überschreibt nichts.`);
  blockers.push(...freeSpaceBlockers(route.to, bytesToCopy));
  return { files, dirs, alreadyPresent, blockers };
}
