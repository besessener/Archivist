import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
let hashed: string[];

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ scan: { enabled: true } });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Zusammenfassung', categoryPath: 'Arbeit/notes' }));
  hashed = [];
  const run = app.services.pool.run.bind(app.services.pool) as (task: string, payload: { path: string }) => Promise<unknown>;
  vi.spyOn(app.services.pool, 'run').mockImplementation(((task: string, payload: { path: string }) => {
    if (task === 'hashFile') hashed.push(path.basename(payload.path));
    return run(task, payload);
  }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

async function scanAll() {
  await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
  await app.ok('scanner:start', {});
  await app.services.jobs.whenIdle();
}

async function analyzeAll() {
  const fileIds = (await app.ok('scanner:getResults', {})).files.map((f) => f.id);
  await app.ok('scanner:analyze', { fileIds, confirmLlm: true });
  await app.services.jobs.whenIdle();
}

describe('file reads during ingestion', () => {
  it('hashes a scanned file again for the analysis, whose hash goes into the document', async () => {
    app.file('Downloads/notiz.txt', 'Notiz mit ausreichend Inhalt eins');
    await scanAll();
    expect(hashed.filter((name) => name === 'notiz.txt')).toHaveLength(1);
    await analyzeAll();
    expect(hashed.filter((name) => name === 'notiz.txt')).toHaveLength(2);
    expect((await app.ok('scanner:getResults', {})).files[0]!.status).toBe('analyzed');
  });

  it('detects a same-size change with a restored mtime: the document gets the new hash and can be archived', async () => {
    const fixed = new Date('2024-01-01T10:00:00Z');
    const file = app.file('Downloads/vertrag.txt', 'Vertrag Version AAAA mit ausreichend Inhalt');
    fs.utimesSync(file, fixed, fixed);
    await scanAll();
    fs.writeFileSync(file, 'Vertrag Version BBBB mit ausreichend Inhalt');
    fs.utimesSync(file, fixed, fixed);
    await analyzeAll();
    const scanned = (await app.ok('scanner:getResults', {})).files[0]!;
    const content = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect((await app.ok('documents:get', { id: scanned.documentId! })).sha256).toBe(content);
    const res = await app.ok('documents:archive', {
      items: [{ documentId: scanned.documentId!, mode: 'copy' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    } as never);
    expect(res.success).toBe(1);
  });

  it('hashes again when the file changed after the scan', async () => {
    const file = app.file('Downloads/notiz.txt', 'Notiz mit ausreichend Inhalt eins');
    await scanAll();
    const before = (await app.ok('scanner:getResults', {})).files[0]!.sha256;
    fs.writeFileSync(file, 'Notiz mit anderem, längerem Inhalt als beim Scan');
    await analyzeAll();
    expect(hashed.filter((name) => name === 'notiz.txt')).toHaveLength(2);
    const scanned = (await app.ok('scanner:getResults', {})).files[0]!;
    expect(scanned.sha256).not.toBe(before);
    expect((await app.ok('documents:get', { id: scanned.documentId! })).sha256).toBe(scanned.sha256);
  });

  it('hashes an uploaded file once, and archiving reads the original and the copy through the pool', async () => {
    const src = app.file('in/upload.txt', 'Upload mit ausreichend Inhalt eins');
    const imported = await app.ok('documents:import', { paths: [src] });
    await app.services.jobs.whenIdle();
    expect(hashed.filter((name) => name === 'upload.txt')).toHaveLength(1);
    hashed.length = 0;
    const res = await app.ok('documents:archive', {
      items: [{ documentId: imported.imported[0]!.id, mode: 'copy' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    } as never);
    expect(res.success).toBe(1);
    // the source check before and the verification of the archive copy
    expect(hashed).toHaveLength(2);
  });
});
