import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, MIME_BY_EXT } from '../parsers';
import type { ParsedDocument, ParseOptions } from '../parsers/parsed-document';
import { sha256File } from '../util/hash';
import { isInside } from '../util/paths';

// CPU/IO-heavy tasks that run in the worker thread (or inline in tests). No database access!

export interface ScanEntry {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  mime: string;
}

export interface ScanDirectoryInput {
  root: string;
  recursive: boolean;
  /** Absolute paths of subfolders that are skipped */
  excludedDirs: string[];
  /** Absolute paths of individual excluded files */
  excludedFiles: string[];
  extensions: string[];
  maxSizeBytes: number;
  /** Matching files per page (default `SCAN_PAGE_SIZE`). */
  pageSize?: number;
  /** Path of the last file of the previous page; the walk continues after it in the same order. */
  after?: string;
  /** Real paths of the directories already walked in earlier pages (symlink loops and aliases stay caught). */
  visited?: string[];
}

export interface ScanDirectoryResult {
  entries: ScanEntry[];
  skipped: { path: string; reason: string }[];
  errors: string[];
  /** Cursor for the next page, or null when the walk is complete. */
  nextCursor: string | null;
  /** Real paths of all directories walked so far, to pass on with the next page. */
  visited: string[];
  /** Directories and entries that could not be read; whatever lies at or below them was not seen. */
  unreadable: string[];
}

/** Default number of files one `scanDirectory` page collects; the caller processes page by page. */
export const SCAN_PAGE_SIZE = 500;

const ALWAYS_SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'appdata', '.git', '.svn', '.cache']);

/** One walk of an approved directory; symlinks are followed only inside the root, loops are caught via realpath. */
class DirectoryWalk {
  readonly result: ScanDirectoryResult = { entries: [], skipped: [], errors: [], nextCursor: null, visited: [], unreadable: [] };
  private readonly visited: Set<string>;
  private readonly extensions: Set<string>;
  private readonly excludedDirs: string[];
  private readonly excludedFiles: Set<string>;
  private readonly pageSize: number;
  private readonly openDirectories: string[] = [];
  private unfinished: string[] = [];

  constructor(
    private readonly input: ScanDirectoryInput,
    private readonly realRoot: string,
  ) {
    this.visited = new Set<string>([realRoot, ...(input.visited ?? [])]);
    this.extensions = new Set(input.extensions.map((extension) => extension.toLowerCase().replace(/^\./, '')));
    this.excludedDirs = input.excludedDirs.map((dir) => path.resolve(dir));
    this.excludedFiles = new Set(input.excludedFiles.map((file) => path.resolve(file)));
    this.pageSize = input.pageSize ?? SCAN_PAGE_SIZE;
  }

  /** Walks `dir`; `cursor` are the remaining path segments of the previous page's last file, everything ordered before it is skipped. */
  async walk(dir: string, cursor: string[] = []): Promise<void> {
    for (const name of await this.readNames(dir)) {
      if (this.result.nextCursor !== null) return;
      const resume = cursor[0];
      if (resume !== undefined && name < resume) continue;
      const full = path.join(dir, name);
      if (name.startsWith('.') || ALWAYS_SKIP_DIRS.has(name.toLowerCase())) continue;
      try {
        await this.visit(full, { name, cursor: name === resume ? cursor.slice(1) : null });
      } catch (err) {
        this.result.errors.push(`${full}: ${(err as Error).message}`);
        this.result.unreadable.push(full);
      }
    }
  }

  /** Directories walked to the end; the ones the page broke off in are walked again by the next page. */
  visitedDirectories(): string[] {
    return [...this.visited].filter((real) => !this.unfinished.includes(real));
  }

  private async readNames(dir: string): Promise<string[]> {
    try {
      return (await fsp.readdir(dir)).toSorted();
    } catch (err) {
      this.result.errors.push(`${dir}: ${(err as Error).message}`);
      this.result.unreadable.push(dir);
      return [];
    }
  }

  /** `cursor` is the rest of the resume path below this entry, an empty list when the entry is the resume file itself, null when past it. */
  private async visit(full: string, entry: { name: string; cursor: string[] | null }): Promise<void> {
    const target = await this.resolve(full);
    if (!target) return;
    const { cursor } = entry;
    if (target.stats.isDirectory()) await this.visitDirectory(full, { real: target.real, cursor: cursor?.length ? cursor : null });
    else if (target.stats.isFile() && cursor?.length !== 0) this.visitFile({ path: full, real: target.real, name: entry.name, stats: target.stats });
  }

  /** Stats of the entry (of its target for a symlink); a symlink leading out of the root is recorded as skipped. */
  private async resolve(full: string): Promise<{ stats: Stats; real: string } | null> {
    const stats = await fsp.lstat(full);
    if (!stats.isSymbolicLink()) return { stats, real: full };
    const real = await fsp.realpath(full);
    if (!isInside(this.realRoot, real)) {
      this.result.skipped.push({ path: full, reason: 'Symbolischer Link führt aus dem freigegebenen Verzeichnis heraus' });
      return null;
    }
    return { stats: await fsp.stat(full), real };
  }

  private isExcludedDir(...places: string[]): boolean {
    return places.some((place) => this.excludedDirs.some((excluded) => isInside(excluded, place)));
  }

  private async visitDirectory(full: string, target: { real: string; cursor: string[] | null }): Promise<void> {
    const { real, cursor } = target;
    if (!this.input.recursive || this.isExcludedDir(full, real)) return;
    // a directory on the resume path was walked by an earlier page but is not finished
    if (!cursor && this.visited.has(real)) return;
    this.visited.add(real);
    this.openDirectories.push(real);
    await this.walk(full, cursor ?? []);
    this.openDirectories.pop();
  }

  private visitFile(file: { path: string; real: string; name: string; stats: Stats }): void {
    if (this.excludedFiles.has(path.resolve(file.path)) || this.excludedFiles.has(path.resolve(file.real)) || this.isExcludedDir(file.path, file.real)) return;
    const ext = path.extname(file.name).slice(1).toLowerCase();
    if (!this.extensions.has(ext)) return;
    if (file.stats.size > this.input.maxSizeBytes) {
      this.result.skipped.push({ path: file.path, reason: 'Datei überschreitet die maximale Größe' });
      return;
    }
    if (this.result.entries.length >= this.pageSize) {
      // the page ends only when another matching file follows, so a last full page needs no empty one
      this.result.nextCursor = this.result.entries[this.result.entries.length - 1]!.path;
      this.unfinished = [...this.openDirectories];
      return;
    }
    const { size, mtimeMs } = file.stats;
    this.result.entries.push({ path: file.path, name: file.name, ext, size, mtimeMs, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' });
  }
}

/** Walks an approved directory and collects the matching files. */
export async function scanDirectory(input: ScanDirectoryInput): Promise<ScanDirectoryResult> {
  const walk = new DirectoryWalk(input, await fsp.realpath(input.root));
  await walk.walk(input.root, input.after ? path.relative(input.root, input.after).split(path.sep) : []);
  return { ...walk.result, visited: walk.visitedDirectories() };
}

export interface CosineTopKInput {
  query: Float32Array;
  /** Row-major vectors; usually a view on a SharedArrayBuffer of the vector index (not copied to the worker). */
  matrix: Float32Array;
  dim: number;
  k: number;
  minScore: number;
  /** Number of rows to consider (default: all rows of `matrix`). */
  rows?: number;
  /** Type code per row; 0 = removed row, skipped. */
  types?: Uint8Array;
  /** Only rows whose type code is set to 1 here are considered. */
  typeMask?: Uint8Array | null;
}

export function cosineTopK(input: CosineTopKInput): { index: number; score: number }[] {
  const { query, matrix, dim, k, minScore, types, typeMask } = input;
  const rowCount = Math.min(input.rows ?? Infinity, Math.floor(matrix.length / dim));
  const scores: { index: number; score: number }[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    if (types) {
      const code = types[row] ?? 0;
      if (code === 0 || (typeMask && typeMask[code] !== 1)) continue;
    }
    let dot = 0;
    const offset = row * dim;
    for (let column = 0; column < dim; column += 1) dot += (query[column] ?? 0) * (matrix[offset + column] ?? 0);
    if (dot >= minScore) scores.push({ index: row, score: dot });
  }
  return scores.toSorted((a, b) => b.score - a.score).slice(0, k);
}

export interface TaskMap {
  hashFile: { in: { path: string; /** Only set when the task runs inline; a worker is terminated instead. */ signal?: AbortSignal }; out: string };
  scanDirectory: { in: ScanDirectoryInput; out: ScanDirectoryResult };
  extractDocument: { in: { path: string; options?: ParseOptions }; out: ParsedDocument };
  cosineTopK: { in: CosineTopKInput; out: { index: number; score: number }[] };
}
export type TaskName = keyof TaskMap;

export const tasks: { [K in TaskName]: (input: TaskMap[K]['in']) => Promise<TaskMap[K]['out']> } = {
  hashFile: ({ path: file, signal }) => sha256File(file, signal),
  scanDirectory,
  extractDocument: ({ path: file, options }) => parseDocument(file, options),
  cosineTopK: async (input) => cosineTopK(input),
};
