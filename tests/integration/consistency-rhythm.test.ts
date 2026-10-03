import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const HOUR = 3_600_000;
const LAST_RUN_KEY = 'consistency.lastRunAt';

const apps: TestApp[] = [];
let root: string;

/** Starts the app on a fixed data folder, like a real start after a previous session. */
async function startApp(prepare?: (app: TestApp) => void): Promise<TestApp> {
  const app = await createTestApp({ dataRoot: root });
  apps.push(app);
  prepare?.(app);
  app.services.start();
  return app;
}

async function restart(app: TestApp, prepare?: (next: TestApp) => void): Promise<TestApp> {
  await app.services.jobs.whenIdle();
  await app.services.shutdown();
  apps.splice(apps.indexOf(app), 1);
  return startApp(prepare);
}

const lastRunAt = (app: TestApp) => Date.parse(app.services.appState.get(LAST_RUN_KEY) ?? '');
const consistencyJobs = (app: TestApp) => app.services.jobs.list().filter((j) => j.type === 'consistency.check');
const completionNotices = (app: TestApp) => app.services.notifications.list().filter((n) => n.type === 'consistency_done');

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.services.jobs.whenIdle();
    await app.services.shutdown();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Archive check: schedule across restarts', () => {
  it('remembers the last run and schedules from the last run after a restart', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-rhythm-'));
    const first = await startApp((app) => app.services.settings.update({ consistency: { onStartup: false, intervalHours: 24 } }));
    expect(first.services.appState.get(LAST_RUN_KEY)).toBeNull();
    await first.services.consistency.run({ trigger: 'manual' });
    const ran = lastRunAt(first);
    expect(Number.isFinite(ran)).toBe(true);

    const second = await restart(first);
    // not 24 h after this start, and no extra check on start
    expect(second.services.consistency.nextRunAt()).toBe(ran + 24 * HOUR);
    expect(consistencyJobs(second)).toHaveLength(0);
  });

  it('catches up on an overdue run exactly once after start', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-rhythm-'));
    const app = await startApp((a) => {
      a.services.settings.update({ consistency: { onStartup: false, intervalHours: 24 } });
      a.services.appState.set(LAST_RUN_KEY, new Date(Date.now() - 25 * HOUR).toISOString());
    });
    await new Promise((r) => setTimeout(r, 20));
    await app.services.jobs.whenIdle();
    expect(consistencyJobs(app)).toHaveLength(1);
    expect(consistencyJobs(app)[0]).toMatchObject({ status: 'succeeded' });
    expect(app.services.consistency.nextRunAt()).toBeGreaterThan(Date.now() + 23 * HOUR);
  });

  it('does not start a second check with „beim Start prüfen“ and an overdue interval', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-rhythm-'));
    const app = await startApp((a) => {
      a.services.settings.update({ consistency: { onStartup: true, intervalHours: 24 } });
      a.services.appState.set(LAST_RUN_KEY, new Date(Date.now() - 48 * HOUR).toISOString());
    });
    await new Promise((r) => setTimeout(r, 20));
    await app.services.jobs.whenIdle();
    expect(consistencyJobs(app)).toHaveLength(1);
    expect(app.services.jobs.list().find((j) => j.type === 'consistency.check')).toMatchObject({ status: 'succeeded' });
  });
});

describe('Archive check: notification only for new findings', () => {
  it('reports nothing without findings; completion is listed in the job history', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-rhythm-'));
    const app = await startApp((a) => a.services.settings.update({ consistency: { onStartup: false } }));
    const job = app.services.enqueueConsistency('manual');
    await app.services.jobs.whenIdle();

    expect(completionNotices(app)).toHaveLength(0);
    const [entry] = (await app.ok('jobs:list', {})).filter((j) => j.id === job.id);
    expect(entry).toMatchObject({ status: 'succeeded', summary: 'Nichts Neues – keine Auffälligkeiten.' });
  });

  it('reports new findings once and stays silent on the next run when nothing is added', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-rhythm-'));
    const app = await startApp((a) => a.services.settings.update({ consistency: { onStartup: false } }));
    await app.ok('openItems:create', { title: 'Angebot prüfen', dueAt: '2026-01-05' });

    const first = await app.services.consistency.run({ trigger: 'interval' });
    expect(first.newFindings).toBeGreaterThan(0);
    expect(completionNotices(app)).toHaveLength(1);
    expect(completionNotices(app)[0]!.title).toMatch(/^Archivprüfung: \d+ neue[rn]? Hinweis/);

    const second = await app.services.consistency.run({ trigger: 'interval' });
    expect(second.newFindings).toBe(0);
    expect(second.summary).toMatch(/^Nichts Neues – /);
    expect(completionNotices(app)).toHaveLength(1);

    // a further finding is new again
    await app.ok('openItems:create', { title: 'Vertrag kündigen', dueAt: '2026-01-06' });
    const third = await app.services.consistency.run({ trigger: 'interval' });
    expect(third.newFindings).toBeGreaterThan(0);
    expect(completionNotices(app)).toHaveLength(2);
  });
});
