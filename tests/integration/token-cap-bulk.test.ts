import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archived } from '../helpers/agent';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
const TOKENS_PER_CALL = 15;
const classifications = () => app.llm.calls.filter((call) => call.schema === 'DocumentClassification');
const jobOf = (type: string) => app.services.jobs.list().find((job) => job.type === type)!;
const titles = () => app.services.notifications.list().map((notification) => notification.title);

async function setup() {
  app = await createTestApp({ privacy: 'auto', scanEnabled: true });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen' }));
}

/** Sets the daily limit so that exactly `calls` more classifications fit into today's tokens. */
async function capAfter(calls: number) {
  app.llm.textUsage = { input: 1500, output: 500, cached: 0 };
  await app.services.llm.complete({ instructions: 'Test', input: 'Hallo', purpose: 'Verbrauch' });
  app.llm.textUsage = { input: 10, output: 5, cached: 0 };
  const { today } = await app.ok('llm:usage', {});
  await app.ok('settings:update', { llm: { dailyTokenCap: today.totalTokens + calls * TOKENS_PER_CALL } });
}

async function untilPaused(type: string) {
  for (let waited = 0; waited < 5_000; waited += 20) {
    if (jobOf(type)?.progressMessage?.includes('Tageslimit')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job ${type} did not pause`);
}

async function resume(type: string) {
  await app.ok('settings:update', { llm: { dailyTokenCap: null } });
  await app.services.jobs.whenIdle();
  return jobOf(type);
}

const documentStatuses = async () => (await app.ok('documents:list', {})).map((document) => document.status);

function scanFiles(names = NAMES) {
  for (const name of names) app.file(`Downloads/${name}`, `Datei ${name} mit ausreichend Text, damit die Analyse etwas zu lesen hat.`);
}

describe('daily token limit in bulk jobs (#153, #228)', () => {
  it('„Alle neuen Dateien analysieren“ stops at the limit, leaves the rest untouched and continues once the limit is gone', async () => {
    await setup();
    scanFiles();
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    await capAfter(2);

    await app.ok('scanner:analyzeAll', { confirmLlm: true });
    await untilPaused('scanner.analyzeAll');

    const files = app.services.scanner.getResults({}).files;
    expect(files.filter((file) => file.status === 'analyzed')).toHaveLength(2);
    expect(files.filter((file) => file.status === 'new')).toHaveLength(3);
    expect(await documentStatuses()).not.toContain('failed');
    expect(jobOf('scanner.analyzeAll')).toMatchObject({ status: 'pending', attempts: 0, error: null });
    const pause = app.services.notifications.list().find((notification) => notification.title === 'Analyse pausiert')!;
    expect(pause.description).toContain('2 von 5 analysiert');
    expect(titles()).not.toContain('Analyse abgeschlossen');

    const job = await resume('scanner.analyzeAll');

    expect(job).toMatchObject({ status: 'succeeded', summary: '5 Dokumente analysiert, 0 Fehler' });
    expect(classifications()).toHaveLength(5);
  });

  it('„Auswahl analysieren“ stops at the limit without failing the remaining files', async () => {
    await setup();
    scanFiles();
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const ids = app.services.scanner.getResults({}).files.map((file) => file.id);
    await capAfter(1);

    await app.ok('scanner:analyze', { fileIds: ids, confirmLlm: true });
    await untilPaused('scanner.analyze');

    const files = app.services.scanner.getResults({}).files;
    expect(files.filter((file) => file.status === 'analyzed')).toHaveLength(1);
    expect(files.filter((file) => file.status === 'new')).toHaveLength(4);
    expect(await documentStatuses()).not.toContain('failed');
    expect(titles()).toContain('Analyse pausiert');

    const job = await resume('scanner.analyze');

    expect(job.status).toBe('succeeded');
    expect(app.services.scanner.getResults({}).files.every((file) => file.status === 'analyzed')).toBe(true);
  });

  it('the analysis of several uploaded files leaves the rest in the inbox as it was', async () => {
    await setup();
    await capAfter(2);
    const paths = NAMES.map((name) => app.file(`Downloads/${name}`, `Datei ${name} mit ausreichend Text, damit die Analyse etwas zu lesen hat.`));

    await app.ok('documents:import', { paths });
    await untilPaused('documents.analyzeBatch');

    const statuses = await documentStatuses();
    expect(statuses.filter((status) => status === 'proposed')).toHaveLength(2);
    expect(statuses.filter((status) => status === 'staged')).toHaveLength(3);
    expect(statuses).not.toContain('failed');
    expect(statuses).not.toContain('analyzing');

    const job = await resume('documents.analyzeBatch');

    expect(job).toMatchObject({ status: 'succeeded', summary: '5 Dokumente analysiert, 0 Fehler' });
    expect((await documentStatuses()).every((status) => status === 'proposed')).toBe(true);
  });

  it('a folder import pauses its analysis at the limit and continues with the missing documents only', async () => {
    await setup();
    await capAfter(2);
    for (const name of NAMES) app.file(`Archiv/${name}`, `Datei ${name} mit ausreichend Text, damit die Analyse etwas zu lesen hat.`);

    await app.ok('documents:import', { paths: [path.join(app.home, 'Archiv')] });
    await untilPaused('documents.analyzeBatch');

    const statuses = await documentStatuses();
    expect(statuses.filter((status) => status === 'proposed')).toHaveLength(2);
    expect(statuses.filter((status) => status === 'staged')).toHaveLength(3);
    expect(jobOf('documents.importFolder').status).toBe('succeeded');

    const job = await resume('documents.analyzeBatch');

    expect(job.summary).toBe('5 Dokumente analysiert, 0 Fehler');
    expect(titles().filter((title) => title.startsWith('Ordner'))).toHaveLength(1);
  });

  it('re-processing archived documents pauses at the limit and keeps the rest for later', async () => {
    await setup();
    const ids = [];
    for (const name of ['x.txt', 'y.txt', 'z.txt'])
      ids.push(await archived(app, { name, content: `Inhalt von ${name} mit genug Text für die Analyse.`, folder: 'private/wohnen' }));
    await capAfter(1);

    await app.ok('documents:reprocess', { ids, reread: false, reanalyze: true, confirmLlm: true });
    await untilPaused('documents.reprocess');

    expect(titles()).toContain('Neuverarbeitung pausiert');
    expect((await app.ok('documents:reanalysisPending', {})).documentIds).toHaveLength(1);
    expect(jobOf('documents.reprocess')).toMatchObject({ status: 'pending', attempts: 0 });

    const job = await resume('documents.reprocess');

    expect(job.status).toBe('succeeded');
    expect((await app.ok('documents:reanalysisPending', {})).documentIds).toHaveLength(3);
  });

  it('keeps the single-document analysis as before: it waits in „wird analysiert“', async () => {
    await setup();
    await capAfter(0);

    const { imported } = await app.ok('documents:import', { paths: [app.file('Downloads/a.txt', 'Eine kurze Notiz zum Test.')] });
    await untilPaused('document.analyze');

    expect((await app.ok('documents:get', { id: imported[0]!.id })).status).toBe('analyzing');
  });
});
