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
  maxFiles?: number;
}

export interface ScanDirectoryResult {
  entries: ScanEntry[];
  skipped: { path: string; reason: string }[];
  errors: string[];
  /** True when the walk stopped at `maxFiles` although more matching files exist. */
  limitReached: boolean;
  /** Directories and entries that could not be read; whatever lies at or below them was not seen. */
  unreadable: string[];
}

/** Default upper bound of files collected per scan root. */
export const SCAN_MAX_FILES = 20_000;

const ALWAYS_SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'appdata', '.git', '.svn', '.cache']);

/** One walk of an approved directory; symlinks are followed only inside the root, loops are caught via realpath. */
class DirectoryWalk {
  readonly result: ScanDirectoryResult = { entries: [], skipped: [], errors: [], limitReached: false, unreadable: [] };
  private readonly visited: Set<string>;
  private readonly extensions: Set<string>;
  private readonly excludedDirs: string[];
  private readonly excludedFiles: Set<string>;
  private readonly maxFiles: number;

  constructor(
    private readonly input: ScanDirectoryInput,
    private readonly realRoot: string,
  ) {
    this.visited = new Set<string>([realRoot]);
    this.extensions = new Set(input.extensions.map((extension) => extension.toLowerCase().replace(/^\./, '')));
    this.excludedDirs = input.excludedDirs.map((dir) => path.resolve(dir));
    this.excludedFiles = new Set(input.excludedFiles.map((file) => path.resolve(file)));
    this.maxFiles = input.maxFiles ?? SCAN_MAX_FILES;
  }

  async walk(dir: string): Promise<void> {
    if (this.result.limitReached) return;
    for (const name of await this.readNames(dir)) {
      if (this.result.limitReached) return;
      const full = path.join(dir, name);
      if (name.startsWith('.') || ALWAYS_SKIP_DIRS.has(name.toLowerCase())) continue;
      try {
        await this.visit(full, name);
      } catch (err) {
        this.result.errors.push(`${full}: ${(err as Error).message}`);
        this.result.unreadable.push(full);
      }
    }
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

  private async visit(full: string, name: string): Promise<void> {
    const target = await this.resolve(full);
    if (!target) return;
    if (target.stats.isDirectory()) await this.visitDirectory(full, target.real);
    else if (target.stats.isFile()) this.visitFile({ path: full, name, stats: target.stats });
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

  private isExcludedDir(full: string): boolean {
    return this.excludedDirs.some((excluded) => isInside(excluded, full));
  }

  private async visitDirectory(full: string, real: string): Promise<void> {
    if (!this.input.recursive || this.isExcludedDir(full) || this.visited.has(real)) return;
    this.visited.add(real);
    await this.walk(full);
  }

  private visitFile(file: { path: string; name: string; stats: Stats }): void {
    if (this.excludedFiles.has(path.resolve(file.path)) || this.isExcludedDir(file.path)) return;
    const ext = path.extname(file.name).slice(1).toLowerCase();
    if (!this.extensions.has(ext)) return;
    if (file.stats.size > this.input.maxSizeBytes) {
      this.result.skipped.push({ path: file.path, reason: 'Datei überschreitet die maximale Größe' });
      return;
    }
    if (this.result.entries.length >= this.maxFiles) {
      // stop only when another matching file would exceed the limit, so exactly `maxFiles` files is not "truncated"
      this.result.limitReached = true;
      return;
    }
    const { size, mtimeMs } = file.stats;
    this.result.entries.push({ path: file.path, name: file.name, ext, size, mtimeMs, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' });
  }
}

/** Walks an approved directory and collects the matching files. */
export async function scanDirectory(input: ScanDirectoryInput): Promise<ScanDirectoryResult> {
  const walk = new DirectoryWalk(input, await fsp.realpath(input.root));
  await walk.walk(input.root);
  return walk.result;
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
