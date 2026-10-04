import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

const hashOf = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const notifications = () => app.services.notifications.list();
const folderJob = () => app.services.jobs.list().find((job) => job.type === 'documents.importFolder')!;

async function setup(privacy: 'auto' | 'confirm') {
  app = await createTestApp({ privacy });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen' }));
}

function archiveTree(): string {
  app.file('Altarchiv/2019/brief.txt', 'Brief aus dem Jahr 2019 mit genug Text, damit er analysiert werden kann.');
  app.file('Altarchiv/2019/tief/unten/rechnung.md', '# Rechnung\nRechnung 4711 über 120 Euro für die Wartung.');
  app.file('Altarchiv/2020/protokoll.txt', 'Protokoll der Sitzung vom 3. März 2020 mit mehreren Beschlüssen.');
  app.file('Altarchiv/.versteckt/geheim.txt', 'Versteckter Ordner, wird nicht übernommen.');
  app.file('Altarchiv/node_modules/x/readme.md', 'Abhängigkeit, wird nicht übernommen.');
  app.file('Altarchiv/programm.exe', 'MZ');
  app.file('Altarchiv/leer.txt', '');
  return path.join(app.home, 'Altarchiv');
}

describe('Dropping a folder imports it recursively (#228)', () => {
  beforeEach(() => setup('auto'));

  it('copies the supported files of all levels into the inbox, analyses them and leaves the originals alone', async () => {
    const root = archiveTree();
    const before = hashOf(path.join(root, '2019', 'brief.txt'));

    const result = await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    expect(result.imported).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.folders).toEqual([{ path: root, jobId: folderJob().id }]);
    const documents = await app.ok('documents:list', {});
    expect(documents.map((d) => d.originalName).sort()).toEqual(['brief.txt', 'protokoll.txt', 'rechnung.md']);
    expect(documents.every((d) => d.status === 'proposed')).toBe(true);
    expect(documents.every((d) => d.stagedPath?.startsWith(app.services.paths.inbox))).toBe(true);
    expect(hashOf(path.join(root, '2019', 'brief.txt'))).toBe(before);
    expect(fs.existsSync(path.join(root, '2019', 'tief', 'unten', 'rechnung.md'))).toBe(true);
  });

  it('reports once for the whole folder instead of once per file', async () => {
    const root = archiveTree();

    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    const titles = notifications().map((n) => n.title);
    expect(titles).toEqual(['Ordner „Altarchiv“ importiert']);
    expect(notifications()[0]!.description).toContain('3 Dokumente analysiert, 0 Fehler');
    expect(folderJob()).toMatchObject({ status: 'succeeded', summary: expect.stringContaining('3 Dokumente übernommen') });
  });

  it('shows the progress of the copying and of the analysis in the job', async () => {
    const root = archiveTree();
    const messages: string[] = [];
    app.services.events.on('job:updated', (job: { progressMessage: string | null }) => job.progressMessage && messages.push(job.progressMessage));

    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/von 4 Dateien kopiert/), expect.stringMatching(/\d von 3 analysiert/)]));
  });

  it('skips content that is already there and says so', async () => {
    const root = archiveTree();
    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    expect(await app.ok('documents:list', {})).toHaveLength(3);
    const second = app.services.jobs.list().filter((job) => job.type === 'documents.importFolder')[0]!;
    expect(second.status).toBe('succeeded');
    expect(notifications().find((n) => n.description.includes('Duplikate'))?.description).toContain('3 Duplikate');
  });

  it('stops at the cap and tells how to continue', async () => {
    const root = archiveTree();
    app.services.documents.folderImport.maxFiles = 2;

    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    expect(await app.ok('documents:list', {})).toHaveLength(2);
    expect(notifications()[0]!.description).toContain('mehr als 2 unterstützte Dateien; nur die ersten 2 wurden übernommen');
    expect(folderJob().summary).toContain('nur die ersten 2');
  });

  it('continues a folder import after a restart without importing files twice', async () => {
    const root = archiveTree();
    await app.services.jobs.stop();
    const { folders } = await app.ok('documents:import', { paths: [root] });
    app.services.database.sqlite
      .prepare('UPDATE jobs SET result = ? WHERE id = ?')
      .run(
        JSON.stringify({ checkpoint: { startedAt: new Date(0).toISOString(), copied: 2, imported: 2, duplicates: 0, rejected: 0, analysis: null } }),
        folders[0]!.jobId,
      );
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(folderJob().status).toBe('succeeded');
    expect((await app.ok('documents:list', {})).length).toBe(1);
  });

  it('analyses the copies of a chunk replayed after an interruption, although its checkpoint was never saved', async () => {
    const root = archiveTree();
    const before = new Date(Date.now() - 1_000).toISOString();
    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();
    const jobId = folderJob().id;
    app.services.database.sqlite
      .prepare("UPDATE jobs SET status = 'pending', finished_at = NULL, result = ? WHERE id = ?")
      .run(JSON.stringify({ checkpoint: { startedAt: before, copied: 0, imported: 0, duplicates: 0, rejected: 0, importedIds: [] } }), jobId);

    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    const analyses = app.services.jobs.list().filter((job) => job.type === 'documents.analyzeBatch');
    expect(analyses).toHaveLength(2);
    const replayed = app.services.jobs.payloadOf<{ documentIds: string[] }>(analyses[0]!.id)!;
    expect(replayed.documentIds).toHaveLength(3);
    expect(await app.ok('documents:list', {})).toHaveLength(3);
  });

  it('keeps the notification of a single file and aggregates several files', async () => {
    const one = app.file('Einzeln/a.txt', 'Eine einzelne Datei mit ausreichend Text für die Analyse.');
    await app.ok('documents:import', { paths: [one] });
    await app.services.jobs.whenIdle();
    expect(notifications().map((n) => n.title)).toEqual(['Klassifikation bereit']);

    const many = ['b', 'c', 'd'].map((n) => app.file(`Mehrere/${n}.txt`, `Datei ${n} mit ausreichend Text für die Analyse, einzigartig ${n}.`));
    await app.ok('documents:import', { paths: [...many, path.join(app.home, 'gibt-es-nicht.txt')] });
    await app.services.jobs.whenIdle();

    const titles = notifications().map((n) => n.title);
    expect(titles.filter((title) => title === 'Klassifikation bereit')).toHaveLength(1);
    expect(titles).toContain('Import abgeschlossen');
    expect(notifications().find((n) => n.title === 'Import abgeschlossen')!.description).toContain('3 Dokumente analysiert, 0 Fehler');
    expect(titles).not.toContain('Dateiimport fehlgeschlagen');
  });
});

describe('A folder import in „vorher fragen“ sends nothing to the LLM', () => {
  beforeEach(() => setup('confirm'));

  it('analyses locally only', async () => {
    const root = archiveTree();

    await app.ok('documents:import', { paths: [root] });
    await app.services.jobs.whenIdle();

    expect(app.llm.calls).toHaveLength(0);
    expect((await app.ok('documents:list', {})).every((d) => d.proposal?.analyzedBy === 'local')).toBe(true);
  });
});
