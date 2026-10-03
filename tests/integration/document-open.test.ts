import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

// Opening never silently shows another version of an archived document (#243).

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

async function imported(name: string, content: string): Promise<{ id: string; source: string }> {
  app.llm.on('DocumentClassification', () =>
    classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: 'private/belege', mainTopic: null }),
  );
  const source = app.file(`in/${name}`, content);
  const res = await app.ok('documents:import', { paths: [source] });
  await app.services.jobs.whenIdle();
  return { id: res.imported[0]!.id, source: fs.realpathSync(source) };
}

async function archived(name: string, content: string): Promise<{ id: string; source: string; file: string }> {
  const doc = await imported(name, content);
  const res = await app.ok('documents:archive', {
    items: [{ documentId: doc.id, mode: 'copy', categoryPath: 'private/belege' }],
    confirmed: true,
    approveNewCategories: ['private'],
    confirmMove: false,
  } as never);
  expect(res.success).toBe(1);
  return { ...doc, file: res.items[0]!.targetPath! };
}

const renameArchiveCopy = (file: string) => fs.renameSync(file, path.join(path.dirname(file), 'umbenannt.txt'));

describe('opening a document file', () => {
  it('opens the archive copy of an archived document', async () => {
    const doc = await archived('rechnung.txt', 'Rechnung 100 Euro');

    await app.ok('app:openPath', { documentId: doc.id });

    expect(app.host.opened).toEqual([doc.file]);
  });

  it('falls back to the original only when its checksum still matches the stored one', async () => {
    const doc = await archived('rechnung.txt', 'Rechnung 100 Euro');
    renameArchiveCopy(doc.file);

    await app.ok('app:openPath', { documentId: doc.id });

    expect(app.host.opened).toEqual([doc.source]);
  });

  it('refuses to open a changed original when the archive copy is missing', async () => {
    const doc = await archived('rechnung.txt', 'Rechnung 100 Euro');
    renameArchiveCopy(doc.file);
    fs.writeFileSync(doc.source, 'Rechnung 999 Euro, neuere Fassung');

    const result = await app.call('app:openPath', { documentId: doc.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe('filesystem_error');
      expect(result.error.message).toMatch(/Archivkopie.*fehlt.*neu verknüpfen/);
    }
    expect(app.host.opened).toEqual([]);
    expect(fs.readFileSync(doc.source, 'utf8'), 'the original stays untouched').toBe('Rechnung 999 Euro, neuere Fassung');
  });

  it('refuses to open anything when archive copy and original are both gone', async () => {
    const doc = await archived('rechnung.txt', 'Rechnung 100 Euro');
    renameArchiveCopy(doc.file);
    fs.rmSync(doc.source);

    const result = await app.call('app:openPath', { documentId: doc.id });

    expect(result.ok).toBe(false);
    expect(app.host.opened).toEqual([]);
  });

  it('applies the same rule when revealing the file', async () => {
    const doc = await archived('rechnung.txt', 'Rechnung 100 Euro');
    renameArchiveCopy(doc.file);
    fs.writeFileSync(doc.source, 'andere Fassung');

    const result = await app.call('app:revealPath', { documentId: doc.id });

    expect(result.ok).toBe(false);
    expect(app.host.opened).toEqual([]);
  });

  it('opens the inbox copy of a document that is not archived yet, then its original', async () => {
    const doc = await imported('brief.txt', 'Brief an die Versicherung');
    const staged = app.services.documents.getRow(doc.id).stagedPath!;

    await app.ok('app:openPath', { documentId: doc.id });
    fs.rmSync(staged);
    await app.ok('app:openPath', { documentId: doc.id });

    expect(app.host.opened).toEqual([staged, doc.source]);
  });

  it('still reports a missing file of a document that is not archived yet', async () => {
    const doc = await imported('brief.txt', 'Brief an die Versicherung');
    fs.rmSync(app.services.documents.getRow(doc.id).stagedPath!);
    fs.rmSync(doc.source);

    const result = await app.call('app:openPath', { documentId: doc.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/nicht gefunden/);
  });
});
