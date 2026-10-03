import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

// Inbox files no document refers to (crash during import) are swept only when an intact archive copy holds the same content.

const HOUR_MS = 60 * 60 * 1000;

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

async function archivedDocument(content: string) {
  app.llm.on('DocumentClassification', () => classification({ title: 'Archiviert', summary: 'Zusammenfassung', categoryPath: 'work/notes', mainTopic: null }));
  const imp = await app.ok('documents:import', { paths: [app.file('in/archiviert.txt', content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  const inbox = path.dirname(app.services.documents.getRow(id).stagedPath!);
  const res = await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'work/notes', topic: null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  expect(res.success).toBe(1);
  return inbox;
}

function orphan(inbox: string, name: string, content: string, ageMs: number): string {
  const file = path.join(inbox, name);
  fs.writeFileSync(file, content);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

describe('Inbox orphans', () => {
  it('removes an old orphan whose content is archived intact', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'rest.txt', 'Archivierter Inhalt', 2 * HOUR_MS);

    expect(await app.services.archive.cleanupInbox()).toBe(1);

    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a fresh orphan (an import may still be running)', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'neu.txt', 'Archivierter Inhalt', 1_000);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps an old orphan whose content is not archived', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'einzig.txt', 'Nirgends sonst vorhanden', 2 * HOUR_MS);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.readFileSync(file, 'utf8')).toBe('Nirgends sonst vorhanden');
  });

  it('keeps an old file that a document still refers to', async () => {
    app.llm.on('DocumentClassification', () => classification({ title: 'Offen', summary: 'Zusammenfassung', categoryPath: 'work/notes', mainTopic: null }));
    const imp = await app.ok('documents:import', { paths: [app.file('in/offen.txt', 'Noch im Eingang')] });
    await app.services.jobs.whenIdle();
    const staged = app.services.documents.getRow(imp.imported[0]!.id).stagedPath!;
    const when = new Date(Date.now() - 2 * HOUR_MS);
    fs.utimesSync(staged, when, when);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.existsSync(staged)).toBe(true);
  });
});
