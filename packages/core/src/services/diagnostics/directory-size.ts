import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 200_000;

/** Total size of the files below `root`; `complete` is false when the walk stopped at the entry limit. */
export async function directorySize(root: string): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    // a folder or file that vanishes during the walk is simply not counted
    const children = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      entries += 1;
      if (entries > MAX_ENTRIES) return { bytes, complete: false };
      const full = path.join(dir, child.name);
      if (child.isDirectory()) pending.push(full);
      else bytes += (await fsp.lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return { bytes, complete: true };
}
