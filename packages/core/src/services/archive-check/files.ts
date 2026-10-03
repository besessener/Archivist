import fs from 'node:fs';

const BATCH = 64;

/** Maps the files asynchronously, a limited number at a time, cancellable between batches. */
async function inBatches<T>(files: string[], request: { probe: (file: string) => Promise<T>; signal?: AbortSignal }): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < files.length; i += BATCH) {
    request.signal?.throwIfAborted();
    out.push(...(await Promise.all(files.slice(i, i + BATCH).map(request.probe))));
  }
  return out;
}

/** Size of each file, or null if it does not exist. */
export function fileSizes(files: string[], signal?: AbortSignal): Promise<(number | null)[]> {
  const probe = (file: string) =>
    fs.promises.stat(file).then(
      (stats) => stats.size,
      () => null,
    );
  return inBatches(files, { probe, signal });
}
