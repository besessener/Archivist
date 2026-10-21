import { getBridge } from './ipc';

export const PATH_UNKNOWN = 'Der Dateipfad konnte nicht ermittelt werden (z. B. bei Dateien aus dem Browser oder aus Archiven).';

/** Absolute paths of picked or dropped files; files without one (browser, archives, clipboard) come back as `unknown`. */
export function filePaths(files: File[]): { paths: string[]; unknown: File[] } {
  const paths: string[] = [];
  const unknown: File[] = [];
  for (const file of files) {
    const path = pathOf(file);
    if (path) paths.push(path);
    else unknown.push(file);
  }
  return { paths, unknown };
}

/** Absolute path of a file, empty for a file without a place on disk. */
export function pathOf(file: File): string {
  try {
    return getBridge()?.getPathForFile(file) ?? '';
  } catch {
    // files without a place on disk (browser, archives) make Electron throw
    return '';
  }
}
