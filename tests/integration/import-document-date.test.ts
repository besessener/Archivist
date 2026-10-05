import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
let documentDateInContent: string | null;
beforeEach(async () => {
  documentDateInContent = null;
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen', documentDate: documentDateInContent }),
  );
});
afterEach(async () => app.cleanup());

const creationDay = (file: string): string => {
  const stat = fs.statSync(file);
  return (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString().slice(0, 10);
};

async function importedDocument(file: string) {
  const { imported } = await app.ok('documents:import', { paths: [file] });
  return imported[0]!;
}

describe('Importing a file takes its creation date as the document date', () => {
  it('sets the document date right at the import, before the analysis ran', async () => {
    const file = app.file('Eingang/notiz.txt', 'Eine Notiz mit ausreichend Text für die Analyse, einzigartig 4711.');

    const document = await importedDocument(file);

    expect(document.documentDate).toBe(creationDay(file));
  });

  it('keeps the creation date when the analysis finds no date in the content', async () => {
    const file = app.file('Eingang/notiz.txt', 'Eine Notiz ganz ohne Datumsangabe, einzigartig 4712.');
    const document = await importedDocument(file);

    await app.services.jobs.whenIdle();

    expect((await app.ok('documents:get', { id: document.id })).documentDate).toBe(creationDay(file));
  });

  it('lets a date found in the content win over the creation date', async () => {
    documentDateInContent = '2020-03-03';
    const file = app.file('Eingang/protokoll.txt', 'Protokoll der Sitzung vom 3. März 2020, einzigartig 4713.');
    const document = await importedDocument(file);

    await app.services.jobs.whenIdle();

    expect((await app.ok('documents:get', { id: document.id })).documentDate).toBe('2020-03-03');
  });
});
