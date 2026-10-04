import type { Readable } from 'node:stream';
import type JSZip from 'jszip';

/** Limits against ZIP bombs: a small archive must not inflate to gigabytes before a parser sees it. */
export const ZIP_LIMITS = {
  maxEntries: 5_000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  /** Beyond `ratioFloorBytes` the output may be at most this many times the archive size. */
  maxRatio: 1_000,
  ratioFloorBytes: 16 * 1024 * 1024,
};

export class ZipLimitError extends Error {
  constructor(reason: string) {
    super(`Die Datei ist ungewöhnlich stark komprimiert und wird nicht gelesen (${reason}).`);
    this.name = 'ZipLimitError';
  }
}

interface Budget {
  total: number;
  readonly archiveBytes: number;
}

/** Streams one entry and stops at the limits instead of after the fact; each chunk within them goes to `onChunk`. */
function streamEntry(entry: JSZip.JSZipObject, { budget, onChunk }: { budget: Budget; onChunk: (chunk: Buffer) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = entry.nodeStream('nodebuffer') as Readable;
    let entryBytes = 0;
    const abort = (reason: string) => {
      source.destroy();
      reject(new ZipLimitError(reason));
    };
    source.on('data', (chunk: Buffer) => {
      entryBytes += chunk.length;
      budget.total += chunk.length;
      if (entryBytes > ZIP_LIMITS.maxEntryBytes) return abort('einzelner Teil zu groß');
      if (budget.total > ZIP_LIMITS.maxTotalBytes) return abort('Gesamtgröße zu groß');
      if (budget.total > ZIP_LIMITS.ratioFloorBytes && budget.total > budget.archiveBytes * ZIP_LIMITS.maxRatio) return abort('Kompressionsverhältnis zu hoch');
      onChunk(chunk);
    });
    source.on('error', reject);
    source.on('end', () => resolve());
  });
}

async function inflateEntry(entry: JSZip.JSZipObject, budget: Budget): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await streamEntry(entry, { budget, onChunk: (chunk) => chunks.push(chunk) });
  return Buffer.concat(chunks);
}

async function openZip(buffer: Buffer): Promise<JSZip> {
  const { default: JSZipClass } = await import('jszip');
  const zip = await JSZipClass.loadAsync(buffer);
  if (Object.keys(zip.files).length > ZIP_LIMITS.maxEntries) throw new ZipLimitError('zu viele Einträge');
  return zip;
}

/** Inflates the parts whose name matches `names` as text, within the ZIP limits. */
export async function readZipXml(buffer: Buffer, names: RegExp): Promise<Array<{ name: string; xml: string }>> {
  const zip = await openZip(buffer);
  const budget: Budget = { total: 0, archiveBytes: buffer.length };
  const parts: Array<{ name: string; xml: string }> = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (names.test(name) && !entry.dir) parts.push({ name, xml: (await inflateEntry(entry, budget)).toString('utf8') });
  }
  return parts;
}

/** Throws a ZipLimitError unless the whole archive inflates within the limits (for parsers that inflate it themselves). */
export async function assertZipWithinLimits(buffer: Buffer): Promise<void> {
  const zip = await openZip(buffer);
  const budget: Budget = { total: 0, archiveBytes: buffer.length };
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) await streamEntry(entry, { budget, onChunk: () => undefined });
  }
}
