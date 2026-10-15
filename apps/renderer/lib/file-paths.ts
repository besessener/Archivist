import { getBridge } from './ipc';

export const PATH_UNKNOWN = 'Der Dateipfad konnte nicht ermittelt werden (z. B. bei Dateien aus dem Browser oder aus Archiven).';

/** Absolute paths of picked or dropped files; files without one (browser, archives) come back as `unknown`. */
export function filePaths(files: File[]): { paths: string[]; unknown: string[] } {
  const bridge = getBridge();
  const paths: string[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    const path = pathOf(bridge, file);
    if (path) paths.push(path);
    else unknown.push(file.name);
  }
  return { paths, unknown };
}

function pathOf(bridge: ReturnType<typeof getBridge>, file: File): string {
  try {
    return bridge?.getPathForFile(file) ?? '';
  } catch {
    // files without a place on disk (browser, archives) make Electron throw
    return '';
  }
}
