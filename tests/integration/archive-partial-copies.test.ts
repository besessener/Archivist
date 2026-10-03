import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

// A crash while copying into the archive leaves `<target>.<uuid>.partial`; the cleanup removes only those, and only old ones.

const HOUR_MS = 60 * 60 * 1000;

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.useRealTimers();
  await app.cleanup();
});

const folder = () => path.join(app.services.settings.get().archiveRoot, 'work', 'leer');
const partialName = (target: string) => `${target}.${randomUUID()}.partial`;

function leftover(name: string): string {
  fs.mkdirSync(folder(), { recursive: true });
  const file = path.join(folder(), name);
  fs.writeFileSync(file, 'halb');
  return file;
}

/** Only Date is faked: file timestamps stay where they were. */
const later = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
};

describe('Leftover partial copies in the archive', () => {
  it('removes an old one and then lets the empty folder go', async () => {
    await app.ok('categories:create', { path: 'work/leer', confirmed: true });
    const partial = leftover(partialName('rechnung.pdf'));
    expect(await app.services.archive.removeEmptyFolders(), 'the leftover makes the folder look occupied').toEqual([]);
    later(2 * HOUR_MS);

    await app.services.archive.cleanupInbox();

    expect(fs.existsSync(partial)).toBe(false);
    expect(await app.services.archive.removeEmptyFolders()).toEqual(['work/leer']);
  });

  it('keeps a fresh one (a copy may be running), also when it carries an old modification time', async () => {
    const partial = leftover(partialName('rechnung.pdf'));
    const old = new Date(Date.now() - 2 * HOUR_MS);
    fs.utimesSync(partial, old, old);

    await app.services.archive.cleanupInbox();

    expect(fs.existsSync(partial)).toBe(true);
  });

  it('keeps old files whose names only look similar', async () => {
    const similar = [
      'bericht.partial',
      'bericht.pdf.partial',
      `bericht.${randomUUID()}.part`,
      `bericht.${randomUUID().slice(1)}.partial`,
      `${randomUUID()}.partial.txt`,
    ].map((name) => leftover(name));
    later(2 * HOUR_MS);

    await app.services.archive.cleanupInbox();

    for (const file of similar) expect(fs.existsSync(file), file).toBe(true);
  });
});
