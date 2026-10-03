import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
const notifications = () => app.services.notifications.list();
const analyzeAllJob = () => app.services.jobs.list().find((job) => job.type === 'scanner.analyzeAll')!;

async function scanned(privacy: 'auto' | 'confirm', names = NAMES) {
  app = await createTestApp({ privacy, scanEnabled: true });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen' }));
  for (const name of names) app.file(`Downloads/${name}`, `Datei ${name} mit ausreichend Text, damit die Analyse etwas zu lesen hat.`);
  await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
  await app.ok('scanner:start', {});
  await app.services.jobs.whenIdle();
  return app.services.scanner.getResults({}).files;
}

describe('„Alle neuen Dateien analysieren“ (#228)', () => {
  it('estimates the count, the files that may go to the LLM and the tokens', async () => {
    await scanned('confirm');

    const estimate = await app.ok('scanner:analyzeAllPreview', {});
    const root = (await app.ok('scanner:listDirectories', {}))[0]!;
    await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: false });

    expect(estimate).toMatchObject({ total: 5, llmEligible: 5 });
    expect(estimate.estimatedTokens).toBeGreaterThan(5 * 500);
    expect(await app.ok('scanner:analyzeAllPreview', {})).toEqual({ total: 5, llmEligible: 0, estimatedTokens: 0 });
  });

  it('analyses every new file in one job with one consent and one notification', async () => {
    await scanned('confirm');

    await app.ok('scanner:analyzeAll', { confirmLlm: true });
    await app.services.jobs.whenIdle();

    const job = analyzeAllJob();
    expect(job).toMatchObject({ status: 'succeeded', summary: '5 Dokumente analysiert, 0 Fehler' });
    expect(app.llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(5);
    expect(notifications().filter((n) => n.title === 'Klassifikation bereit')).toHaveLength(0);
    expect(
      notifications()
        .filter((n) => n.title === 'Analyse abgeschlossen')
        .map((n) => n.description),
    ).toEqual(['5 Dokumente analysiert, 0 Fehler.']);
    expect((await app.ok('scanner:getResults', {})).files.every((f) => f.status === 'analyzed')).toBe(true);
    expect(await app.ok('scanner:analyzeAllPreview', {})).toMatchObject({ total: 0 });
  });

  it('sends nothing to the LLM without the consent', async () => {
    await scanned('confirm');

    await app.ok('scanner:analyzeAll', { confirmLlm: false });
    await app.services.jobs.whenIdle();

    expect(app.llm.calls).toHaveLength(0);
    expect((await app.ok('documents:list', {})).every((d) => d.proposal?.analyzedBy === 'local')).toBe(true);
  });

  it('keeps honouring exclusions: files of a locked folder stay local', async () => {
    const files = await scanned('auto');
    const root = (await app.ok('scanner:listDirectories', {}))[0]!;
    await app.ok('scanner:updateDirectory', { id: root.id, llmAllowed: false });

    await app.ok('scanner:analyzeAll', { confirmLlm: true });
    await app.services.jobs.whenIdle();

    expect(files).toHaveLength(5);
    expect(app.llm.calls).toHaveLength(0);
    expect(analyzeAllJob().summary).toBe('5 Dokumente analysiert, 0 Fehler');
  });

  it('counts a file that cannot be read as an error and reports it once', async () => {
    await scanned('auto');
    fs.rmSync(path.join(app.home, 'Downloads', 'c.txt'));

    await app.ok('scanner:analyzeAll', { confirmLlm: false });
    await app.services.jobs.whenIdle();

    expect(analyzeAllJob().summary).toBe('4 Dokumente analysiert, 1 Fehler');
    const announced = notifications().filter((n) => n.title === 'Analyse abgeschlossen');
    expect(announced).toHaveLength(1);
    expect(announced[0]!.description).toContain('1 Fehler');
    expect(announced[0]!.description).toContain('c.txt');
    expect(notifications().filter((n) => n.title === 'Dateianalyse fehlgeschlagen')).toHaveLength(0);
  });

  it('works through the files oldest first and leaves files queued elsewhere to their job', async () => {
    const files = await scanned('auto', ['b.txt', 'a.txt', 'c.txt']);
    const idOf = (name: string) => files.find((f) => f.name === name)!.id;
    const db = app.services.database.sqlite;
    db.prepare("UPDATE scan_files SET first_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(idOf('c.txt'));
    db.prepare("UPDATE scan_files SET first_seen_at = '2026-03-01T00:00:00.000Z' WHERE id = ?").run(idOf('a.txt'));
    db.prepare("UPDATE scan_files SET llm_status = 'excluded' WHERE id = ?").run(idOf('b.txt'));
    await app.services.jobs.stop();
    app.services.jobs.enqueue('scanner.analyze', { label: 'Auswahl', payload: { fileIds: [idOf('a.txt')], confirmLlm: false } });

    await app.ok('scanner:analyzeAll', { confirmLlm: false });
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    const status = (name: string) => app.services.scanner.getFile(idOf(name)).status;
    expect([status('c.txt'), status('a.txt'), status('b.txt')]).toEqual(['analyzed', 'analyzed', 'new']);
    expect(analyzeAllJob().summary).toBe('1 Dokument analysiert, 0 Fehler');
  });

  it('resumes after the cursor of its checkpoint, so paid-for files are not analysed twice', async () => {
    const files = await scanned('auto', ['a.txt', 'b.txt', 'c.txt']);
    const ordered = [...files].sort((x, y) => x.firstSeenAt.localeCompare(y.firstSeenAt) || x.path.localeCompare(y.path));
    const first = ordered[0]!;
    await app.services.jobs.stop();
    const { jobId } = await app.ok('scanner:analyzeAll', { confirmLlm: false });
    app.services.database.sqlite.prepare('UPDATE jobs SET result = ? WHERE id = ?').run(
      JSON.stringify({
        checkpoint: { next: 1, analyzed: 1, failed: 0, skipped: 0, failures: [] },
      }),
      jobId,
    );
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(analyzeAllJob().summary).toBe('3 Dokumente analysiert, 0 Fehler');
    expect(app.services.scanner.getFile(first.id).status).toBe('new');
  });

  it('processes only the files the user saw when confirming, not files found afterwards', async () => {
    await scanned('auto', ['a.txt', 'b.txt']);
    await app.services.jobs.stop();
    await app.ok('scanner:analyzeAll', { confirmLlm: false });
    app.file('Downloads/spaeter.txt', 'Später gefunden, mit ausreichend Text für die Analyse.');
    await app.services.scanner.runScan(null);

    expect(await app.ok('scanner:analyzeAllPreview', {})).toMatchObject({ total: 3 });
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(analyzeAllJob().summary).toBe('2 Dokumente analysiert, 0 Fehler');
    const later = app.services.scanner.getResults({}).files.find((file) => file.name === 'spaeter.txt')!;
    expect(later.status).toBe('new');
    expect(await app.ok('scanner:analyzeAllPreview', {})).toMatchObject({ total: 1 });
  });

  it('shows how far it is: „2 von 5 analysiert“ with an estimate of the remaining time', async () => {
    await scanned('auto');
    const lines: string[] = [];
    app.services.events.on(
      'job:updated',
      (job: { type: string; progressMessage: string | null }) => job.type === 'scanner.analyzeAll' && job.progressMessage && lines.push(job.progressMessage),
    );

    await app.ok('scanner:analyzeAll', { confirmLlm: false });
    await app.services.jobs.whenIdle();

    expect(lines[0]).toBe('1 von 5 analysiert');
    expect(lines.at(-1)).toBe('5 von 5 analysiert');
    expect(lines.some((line) => /^[34] von 5 analysiert, .+ verbleibend$/.test(line))).toBe(true);
  });

  it('is started after a scan when automatic analysis is on, in „automatisch“ only', async () => {
    app = await createTestApp({ privacy: 'auto', scanEnabled: true });
    app.services.settings.update({ scan: { autoAnalyze: true } });
    app.file('Downloads/auto.txt', 'Automatisch zu analysieren, mit ausreichend Text für die Analyse.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();

    expect(analyzeAllJob().summary).toBe('1 Dokument analysiert, 0 Fehler');
  });
});

describe('Analysing a selection', () => {
  it('reports a selection of several files once, a single file as before', async () => {
    const files = await scanned('auto');

    await app.ok('scanner:analyze', { fileIds: files.slice(0, 3).map((f) => f.id), confirmLlm: false });
    await app.services.jobs.whenIdle();
    expect(
      notifications()
        .filter((n) => n.title === 'Analyse abgeschlossen')
        .map((n) => n.description),
    ).toEqual(['3 Dokumente analysiert, 0 Fehler.']);
    expect(notifications().filter((n) => n.title === 'Klassifikation bereit')).toHaveLength(0);

    await app.ok('scanner:analyze', { fileIds: [files[3]!.id], confirmLlm: false });
    await app.services.jobs.whenIdle();
    expect(notifications().filter((n) => n.title === 'Klassifikation bereit')).toHaveLength(1);
  });

  it('writes a checkpoint of constant size, however many files were handled', async () => {
    const files = await scanned(
      'auto',
      Array.from({ length: 8 }, (_, n) => `datei-${n}.txt`),
    );
    const sizes: number[] = [];
    const job = {
      checkpoint: null,
      saveCheckpoint: (data: unknown) => sizes.push(JSON.stringify(data).length),
      report: () => undefined,
      throwIfCancelled: () => undefined,
      signal: new AbortController().signal,
    };

    await app.services.scanner.analyzeFiles(
      files.map((f) => f.id),
      { confirmLlm: false, job: job as never },
    );

    expect(sizes).toHaveLength(8);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(sizes[0]! + 2);
  });

  it('continues behind the files already handled after a restart', async () => {
    const files = await scanned('auto', ['a.txt', 'b.txt', 'c.txt']);
    const ids = files.map((f) => f.id);
    await app.ok('scanner:analyze', { fileIds: ids.slice(0, 1), confirmLlm: false });
    await app.services.jobs.whenIdle();
    const calls = app.llm.calls.length;
    const job = {
      checkpoint: { next: 1, failed: 0, failures: [] },
      saveCheckpoint: () => undefined,
      report: () => undefined,
      throwIfCancelled: () => undefined,
      signal: new AbortController().signal,
    };

    const result = await app.services.scanner.analyzeFiles(ids, { confirmLlm: false, job: job as never });

    expect(result.analyzed).toHaveLength(3);
    expect(app.services.documents.list({ status: 'proposed' }).length).toBe(3);
    expect(app.llm.calls.length).toBe(calls + 2);
  });
});
