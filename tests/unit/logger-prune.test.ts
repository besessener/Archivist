import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_SIZE_CAP_BYTES, Logger } from '../../packages/core/src/util/logger';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-log-prune-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY_MS = 86_400_000;

/** A log file of `bytes` bytes that was last written `daysAgo` days ago. */
function logFile(name: string, { bytes, daysAgo }: { bytes: number; daysAgo: number }): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  const time = new Date(Date.now() - daysAgo * DAY_MS);
  fs.utimesSync(file, time, time);
  return file;
}

describe('Logger.prune', () => {
  it('deletes files older than the retention period and keeps newer ones', () => {
    const old = logFile('archivist-2026-01-01.log', { bytes: 10, daysAgo: 40 });
    const recent = logFile('archivist-2026-09-01.log', { bytes: 10, daysAgo: 2 });

    new Logger(dir).prune(30);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('deletes the oldest files first until all together fit the size cap', () => {
    const oldest = logFile('archivist-a.log', { bytes: 400, daysAgo: 5 });
    const middle = logFile('archivist-b.log', { bytes: 400, daysAgo: 3 });
    const newest = logFile('archivist-c.log', { bytes: 400, daysAgo: 1 });

    new Logger(dir).prune(30, 900);

    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it('keeps everything while the files are within the cap', () => {
    const files = [logFile('archivist-a.log', { bytes: 100, daysAgo: 2 }), logFile('archivist-b.log', { bytes: 100, daysAgo: 1 })];

    new Logger(dir).prune(30, 1000);

    expect(files.every((file) => fs.existsSync(file))).toBe(true);
  });

  it('never deletes the file it is writing to, even when that alone exceeds the cap', async () => {
    const logger = new Logger(dir, 'info');
    logger.info('test', 'x'.repeat(500));
    await logger.close();
    const today = path.join(dir, fs.readdirSync(dir)[0]!);
    const reopened = new Logger(dir, 'info');
    reopened.info('test', 'again');
    const older = logFile('archivist-2020-01-01.log', { bytes: 300, daysAgo: 10 });

    reopened.prune(30, 100);
    await reopened.close();

    expect(fs.existsSync(today)).toBe(true);
    expect(fs.existsSync(older)).toBe(false);
  });

  it('ignores files that are not log files', () => {
    const other = logFile('notes.txt', { bytes: 5000, daysAgo: 100 });

    new Logger(dir).prune(30, 10);

    expect(fs.existsSync(other)).toBe(true);
  });

  it('has a default cap of 50 MB', () => {
    expect(LOG_SIZE_CAP_BYTES).toBe(50 * 1024 * 1024);
  });
});
