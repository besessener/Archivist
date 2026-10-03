import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

const text = (name: string) => `Datei ${name} mit ausreichend Text, damit die Analyse etwas zu lesen hat.`;
const names = async () => (await app.ok('documents:list', {})).map((document) => document.originalName).sort();
const jobsOf = (type: string) => app.services.jobs.list().filter((job) => job.type === type);

async function setup(privacy: 'auto' | 'confirm' = 'auto') {
  app = await createTestApp({ privacy });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen' }));
}

describe('Dropping a folder: Archivist’s own folders are refused (#228)', () => {
  beforeEach(() => setup());

  it.each([
    ['the data folder', () => app.services.paths.root],
    ['the trash', () => app.services.paths.trash],
    ['the inbox', () => app.services.paths.inbox],
    ['the quarantine', () => app.services.paths.quarantine],
    ['the archive', () => app.services.settings.get().archiveRoot],
  ])('refuses %s with a clear message and starts no job', async (_label, folder) => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'intern.txt'), text('intern'));

    const result = await app.ok('documents:import', { paths: [folder()] });

    expect(result.folders).toHaveLength(0);
    expect(result.rejected).toEqual([{ path: folder(), reason: expect.stringMatching(/eigene Ordner.*können nicht importiert werden/) }]);
    expect(jobsOf('documents.importFolder')).toHaveLength(0);
    expect(await names()).toEqual([]);
  });

  it('refuses a subfolder of the archive as well', async () => {
    const inside = path.join(app.services.settings.get().archiveRoot, 'private', 'wohnen');
    fs.mkdirSync(inside, { recursive: true });

    const result = await app.ok('documents:import', { paths: [inside] });

    expect(result.rejected).toHaveLength(1);
    expect(result.folders).toHaveLength(0);
  });

  it('refuses system folders like the scanner does', async () => {
    const result = await app.ok('documents:import', { paths: [path.parse(app.home).root] });

    expect(result.rejected[0]!.reason).toMatch(/nicht importiert werden/);
    expect(result.folders).toHaveLength(0);
  });

  it('does not walk into Archivist’s own folders when a parent folder is dropped', async () => {
    app.file('Alles/brief.txt', text('brief'));
    const parent = path.dirname(app.services.paths.root);
    const own = path.join(app.services.paths.inbox, 'zwischenkopie.txt');
    fs.mkdirSync(app.services.paths.inbox, { recursive: true });
    fs.writeFileSync(own, text('zwischenkopie'));

    await app.ok('documents:import', { paths: [parent] });
    await app.services.jobs.whenIdle();

    expect(await names()).not.toContain('zwischenkopie.txt');
    expect(await names()).toContain('brief.txt');
  });
});

describe('Dropping a folder: privacy exclusions are honoured (#228)', () => {
  beforeEach(() => setup());

  it('leaves out never-analyse folders, files and file types', async () => {
    app.file('Archiv/offen/ok.txt', text('ok'));
    app.file('Archiv/privat/geheim.txt', text('geheim'));
    app.file('Archiv/offen/einzeln.txt', text('einzeln'));
    app.file('Archiv/offen/tabelle.md', '# Tabelle\nMit genug Text, damit die Analyse etwas zu lesen hat.');
    const root = path.join(app.home, 'Archiv');
    app.services.settings.update({
      privacy: { neverAnalyzeDirs: [path.join(root, 'privat')], neverAnalyzeFiles: [path.join(root, 'offen', 'einzeln.txt')], neverAnalyzeExtensions: ['md'] },
    });

    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    expect(await names()).toEqual(['ok.txt']);
    expect(app.llm.calls.filter((call) => call.input.includes('geheim'))).toHaveLength(0);
  });
});

describe('Dropping a folder analyses only its own documents (#228)', () => {
  beforeEach(() => setup());

  it('leaves documents of other imports untouched and analyses each own document exactly once', async () => {
    app.file('Archiv/a.txt', text('a'));
    app.file('Archiv/b.txt', text('b'));
    const other = app.services.documents.insertDocument({
      originalName: 'fremd.txt',
      ext: 'txt',
      size: 10,
      sha256: 'f'.repeat(64),
      sourcePath: null,
      stagedPath: path.join(app.services.paths.inbox, 'fremd.txt'),
    });

    await app.ok('documents:import', { paths: [path.join(app.home, 'Archiv')] });
    await app.services.jobs.whenIdle();

    expect((await app.ok('documents:get', { id: other.id })).status).toBe('staged');
    expect(app.llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(2);
    expect(jobsOf('documents.analyzeBatch')).toHaveLength(1);
  });

  it('does not analyse a document twice that another upload already queued', async () => {
    const lonely = app.file('Archiv/a.txt', text('a'));
    app.file('Archiv/b.txt', text('b'));
    await app.services.jobs.stop();
    await app.ok('documents:import', { paths: [lonely] });

    await app.ok('documents:import', { paths: [path.join(app.home, 'Archiv')] });
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(app.llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(2);
  });

  it('in „vorher fragen“ the notification offers the LLM analysis of exactly these documents, once consented', async () => {
    await app.cleanup();
    await setup('confirm');
    app.file('Archiv/a.txt', text('a'));
    app.file('Archiv/b.txt', text('b'));

    await app.ok('documents:import', { paths: [path.join(app.home, 'Archiv')] });
    await app.services.jobs.whenIdle();

    expect(app.llm.calls).toHaveLength(0);
    const offer = app.services.notifications
      .list()
      .find((notification) => notification.title.startsWith('Ordner'))!
      .proposedActions.find((a) => a.label.includes('mit KI analysieren'))!;
    expect(offer.label).toBe('Alle 2 mit KI analysieren');
    const batchJobId = new URL(offer.target!, 'http://app.test').searchParams.get('analyzeImport')!;
    expect(await app.ok('documents:analyzeImportEstimate', { jobId: batchJobId })).toMatchObject({ total: 2, llmEligible: 2 });

    await app.ok('documents:analyzeImport', { jobId: batchJobId, confirmLlm: true });
    await app.services.jobs.whenIdle();

    expect(app.llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(2);
    expect((await app.ok('documents:list', {})).every((document) => document.proposal?.analyzedBy === 'llm')).toBe(true);
  });

  it('offers nothing in „automatisch“ and in „nur lokal“', async () => {
    app.file('Archiv/a.txt', text('a'));
    await app.ok('documents:import', { paths: [path.join(app.home, 'Archiv')] });
    await app.services.jobs.whenIdle();
    await app.ok('settings:update', { privacy: { llmMode: 'local_only' } });
    app.file('Zweites/b.txt', text('b'));
    await app.ok('documents:import', { paths: [path.join(app.home, 'Zweites')] });
    await app.services.jobs.whenIdle();

    const offers = app.services.notifications.list().flatMap((notification) => notification.proposedActions.filter((a) => a.label.includes('mit KI')));
    expect(offers).toHaveLength(0);
    const batch = jobsOf('documents.analyzeBatch').find((job) => job.status === 'succeeded')!;
    await expect(app.call('documents:analyzeImport', { jobId: batch.id, confirmLlm: true })).resolves.toMatchObject({ ok: false });
  });
});
