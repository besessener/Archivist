import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, MIME_BY_EXT, type ParseOptions, type ParsedDocument } from '../parsers';
import { sha256File } from '../util/hash';
import { isInside } from '../util/paths';

/** CPU-/IO-lastige Aufgaben, die im Worker-Thread laufen (oder im Test inline). Kein Datenbankzugriff! */

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
  /** Absolute Pfade von Unterordnern, die übersprungen werden */
  excludedDirs: string[];
  /** Absolute Pfade einzelner ausgeschlossener Dateien */
  excludedFiles: string[];
  extensions: string[];
  maxSizeBytes: number;
  maxFiles?: number;
}

export interface ScanDirectoryResult {
  entries: ScanEntry[];
  skipped: { path: string; reason: string }[];
  errors: string[];
}

const ALWAYS_SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'appdata', '.git', '.svn', '.cache']);

/**
 * Durchsucht ein freigegebenes Verzeichnis. Symbolische Links werden nur verfolgt, wenn ihr Ziel
 * innerhalb des freigegebenen Wurzelverzeichnisses liegt; Schleifen werden über realpath erkannt.
 */
export async function scanDirectory(input: ScanDirectoryInput): Promise<ScanDirectoryResult> {
  const realRoot = await fsp.realpath(input.root);
  const result: ScanDirectoryResult = { entries: [], skipped: [], errors: [] };
  const visited = new Set<string>([realRoot]);
  const exts = new Set(input.extensions.map((e) => e.toLowerCase().replace(/^\./, '')));
  const excludedDirs = input.excludedDirs.map((d) => path.resolve(d));
  const excludedFiles = new Set(input.excludedFiles.map((f) => path.resolve(f)));
  const max = input.maxFiles ?? 20_000;

  const walk = async (dir: string): Promise<void> => {
    if (result.entries.length >= max) return;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      result.errors.push(`${dir}: ${(err as Error).message}`);
      return;
    }
    for (const name of names.toSorted()) {
      if (result.entries.length >= max) return;
      const full = path.join(dir, name);
      if (name.startsWith('.') || ALWAYS_SKIP_DIRS.has(name.toLowerCase())) continue;
      try {
        let st = await fsp.lstat(full);
        let real = full;
        if (st.isSymbolicLink()) {
          real = await fsp.realpath(full);
          if (!isInside(realRoot, real)) {
            result.skipped.push({ path: full, reason: 'Symbolischer Link führt aus dem freigegebenen Verzeichnis heraus' });
            continue;
          }
          st = await fsp.stat(full);
        }
        if (st.isDirectory()) {
          if (!input.recursive) continue;
          if (excludedDirs.some((ex) => isInside(ex, full))) continue;
          if (visited.has(real)) continue;
          visited.add(real);
          await walk(full);
        } else if (st.isFile()) {
          if (excludedFiles.has(path.resolve(full)) || excludedDirs.some((ex) => isInside(ex, full))) continue;
          const ext = path.extname(name).slice(1).toLowerCase();
          if (!exts.has(ext)) continue;
          if (st.size > input.maxSizeBytes) {
            result.skipped.push({ path: full, reason: 'Datei überschreitet die maximale Größe' });
            continue;
          }
          result.entries.push({ path: full, name, ext, size: st.size, mtimeMs: st.mtimeMs, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' });
        }
      } catch (err) {
        result.errors.push(`${full}: ${(err as Error).message}`);
      }
    }
  };
  await walk(input.root);
  return result;
}

export function cosineTopK(input: { query: Float32Array; matrix: Float32Array; dim: number; k: number; minScore: number }): { index: number; score: number }[] {
  const { query, matrix, dim, k, minScore } = input;
  const n = Math.floor(matrix.length / dim);
  const scores: { index: number; score: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    let dot = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j += 1) dot += (query[j] ?? 0) * (matrix[off + j] ?? 0);
    if (dot >= minScore) scores.push({ index: i, score: dot });
  }
  return scores.toSorted((a, b) => b.score - a.score).slice(0, k);
}

export interface TaskMap {
  hashFile: { in: { path: string }; out: string };
  scanDirectory: { in: ScanDirectoryInput; out: ScanDirectoryResult };
  extractDocument: { in: { path: string; options?: ParseOptions }; out: ParsedDocument };
  cosineTopK: { in: { query: Float32Array; matrix: Float32Array; dim: number; k: number; minScore: number }; out: { index: number; score: number }[] };
}
export type TaskName = keyof TaskMap;

export const tasks: { [K in TaskName]: (input: TaskMap[K]['in']) => Promise<TaskMap[K]['out']> } = {
  hashFile: ({ path: p }) => sha256File(p),
  scanDirectory,
  extractDocument: ({ path: p, options }) => parseDocument(p, options),
  cosineTopK: async (input) => cosineTopK(input),
};
