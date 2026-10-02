import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const MIN = 60_000;
const HOUR = 3_600_000;

let app: TestApp;
const jobsOfType = (type: string) => app.services.jobs.list().filter((j) => j.type === type);

describe('Schedules react to changes without a restart', () => {
  beforeEach(async () => {
    app = await createTestApp({ scanEnabled: true });
    app.services.settings.update({ consistency: { onStartup: false } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    app.services.start();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await app.services.jobs.whenIdle();
    await app.cleanup();
  });

  it('periodic scan enabled first, folder added later: the timer runs', async () => {
    app.services.settings.update({ scan: { periodic: true, intervalMinutes: 30 } });
    expect(app.services.scanner.nextPeriodicScanAt()).toBeNull();

    const dir = path.join(app.home, 'Downloads');
    fs.mkdirSync(dir);
    await app.ok('scanner:addDirectory', { path: dir, recursive: true });
    expect(app.services.scanner.nextPeriodicScanAt()).toBe(Date.now() + 30 * MIN);

    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(jobsOfType('scanner.scan')).toHaveLength(1);
  });

  it('removing or disabling the last folder and changing scan settings re-plan the timer', async () => {
    const dir = path.join(app.home, 'Downloads');
    fs.mkdirSync(dir);
    const root = await app.ok('scanner:addDirectory', { path: dir, recursive: true });
    expect(app.services.scanner.nextPeriodicScanAt()).toBeNull();

    app.services.settings.update({ scan: { periodic: true, intervalMinutes: 60 } });
    expect(app.services.scanner.nextPeriodicScanAt()).toBe(Date.now() + 60 * MIN);

    // a shorter interval applies right away
    await vi.advanceTimersByTimeAsync(10 * MIN);
    app.services.settings.update({ scan: { intervalMinutes: 15 } });
    expect(app.services.scanner.nextPeriodicScanAt()).toBe(Date.now() + 15 * MIN);

    // unrelated scanner activity does not postpone the pending scan
    const due = app.services.scanner.nextPeriodicScanAt();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    app.services.events.changed('scanner');
    expect(app.services.scanner.nextPeriodicScanAt()).toBe(due);

    await app.ok('scanner:updateDirectory', { id: root.id, enabled: false });
    expect(app.services.scanner.nextPeriodicScanAt()).toBeNull();
    await app.ok('scanner:updateDirectory', { id: root.id, enabled: true });
    expect(app.services.scanner.nextPeriodicScanAt()).not.toBeNull();

    app.services.settings.update({ scan: { enabled: false } });
    expect(app.services.scanner.nextPeriodicScanAt()).toBeNull();
    app.services.settings.update({ scan: { enabled: true } });
    expect(app.services.scanner.nextPeriodicScanAt()).not.toBeNull();

    await app.ok('scanner:removeDirectory', { id: root.id });
    expect(app.services.scanner.nextPeriodicScanAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(jobsOfType('scanner.scan')).toHaveLength(0);
  });

  it('archive check interval changes, including 0, apply immediately', async () => {
    expect(app.services.consistency.nextRunAt()).toBe(Date.now() + 24 * HOUR);

    app.services.settings.update({ consistency: { intervalHours: 0 } });
    expect(app.services.consistency.nextRunAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(jobsOfType('consistency.check')).toHaveLength(0);

    app.services.settings.update({ consistency: { intervalHours: 2 } });
    expect(app.services.consistency.nextRunAt()).toBe(Date.now() + 2 * HOUR);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(jobsOfType('consistency.check')).toHaveLength(1);
  });

  it('a completed archive check restarts the interval', async () => {
    app.services.settings.update({ consistency: { intervalHours: 2 } });
    await vi.advanceTimersByTimeAsync(HOUR);
    await app.services.consistency.run('manual');
    expect(app.services.consistency.nextRunAt()).toBe(Date.now() + 2 * HOUR);
  });
});
