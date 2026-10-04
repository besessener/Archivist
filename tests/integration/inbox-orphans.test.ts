import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

// Inbox files no document refers to (crash during import) are swept only when an intact archive copy holds the same content.

const HOUR_MS = 60 * 60 * 1000;

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await app.cleanup();
});

async function archivedDocument(content: string) {
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Archiviert', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes', mainTopic: null }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file('in/archiviert.txt', content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  const inbox = path.dirname(app.services.documents.getRow(id).stagedPath!);
  const res = await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'Arbeit/notes', topic: null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  expect(res.success).toBe(1);
  return inbox;
}

/** Only Date is faked: the clock moves on while every file timestamp (also creation and change time) stays where it was. */
const later = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
};

function orphan(inbox: string, name: string, content: string): string {
  const file = path.join(inbox, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('Inbox orphans', () => {
  it('removes an old orphan whose content is archived intact', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'rest.txt', 'Archivierter Inhalt');
    later(2 * HOUR_MS);

    expect(await app.services.archive.cleanupInbox()).toBe(1);

    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a fresh orphan (an import may still be running)', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'neu.txt', 'Archivierter Inhalt');
    later(1_000);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps an old orphan whose content is not archived', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'einzig.txt', 'Nirgends sonst vorhanden');
    later(2 * HOUR_MS);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.readFileSync(file, 'utf8')).toBe('Nirgends sonst vorhanden');
  });

  it('keeps an old file that a document still refers to', async () => {
    app.llm.on('DocumentClassification', () => classification({ title: 'Offen', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes', mainTopic: null }));
    const imp = await app.ok('documents:import', { paths: [app.file('in/offen.txt', 'Noch im Eingang')] });
    await app.services.jobs.whenIdle();
    const staged = app.services.documents.getRow(imp.imported[0]!.id).stagedPath!;
    later(2 * HOUR_MS);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.existsSync(staged)).toBe(true);
  });

  it('keeps a fresh copy of an old file: it still carries the old modification time, as a copy does on Windows', async () => {
    const inbox = await archivedDocument('Archivierter Inhalt');
    const file = orphan(inbox, 'kopie.txt', 'Archivierter Inhalt');
    const old = new Date(Date.now() - 2 * HOUR_MS);
    fs.utimesSync(file, old, old);

    expect(await app.services.archive.cleanupInbox()).toBe(0);

    expect(fs.existsSync(file)).toBe(true);
  });

  it('leaves the copy a running undo has just restored, before the undo commits it to the document', async () => {
    app.llm.on('DocumentClassification', () => classification({ title: 'Undo', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes', mainTopic: null }));
    const imp = await app.ok('documents:import', { paths: [app.file('in/undo.txt', 'Inhalt im Undo')] });
    await app.services.jobs.whenIdle();
    const id = imp.imported[0]!.id;
    const staged = app.services.documents.getRow(id).stagedPath!;
    const res = await app.ok('documents:archive', {
      items: [{ documentId: id, mode: 'copy', categoryPath: 'Arbeit/notes', topic: null }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    } as never);
    const realCopyFile = fsp.copyFile.bind(fsp);
    let restored!: () => void;
    const reached = new Promise<void>((resolve) => (restored = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dest, mode) => {
      await realCopyFile(src, dest, mode);
      if (String(dest) !== staged) return;
      later(2 * HOUR_MS);
      restored();
      await gate;
    });

    const undo = app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    await reached;
    const swept = await app.services.archive.cleanupInbox();
    release();

    expect(swept).toBe(0);
    expect(await undo).toMatchObject({ undone: true, conflicts: [] });
    expect(fs.readFileSync(staged, 'utf8')).toBe('Inhalt im Undo');
    expect(app.services.documents.getRow(id).stagedPath).toBe(staged);
  });
});
