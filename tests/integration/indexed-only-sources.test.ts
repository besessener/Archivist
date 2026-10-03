import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

/** Issue #229: originals of „Nur indexieren“ documents that change or vanish must not stay searchable with stale content. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto', scanEnabled: true });
  app.llm.on('DocumentClassification', () => classification({ title: 'Reiseplanung', summary: 'Zusammenfassung', categoryPath: 'work/notes' }));
});
afterEach(async () => {
  await app.cleanup();
});

const OLD = 'Die Reise führt über den Zebrastreifen am Bahnhof.';
const NEW = 'Die Reise führt jetzt an der Giraffenwiese vorbei und dauert deutlich länger als geplant.';

const hits = async (query: string) => (await app.ok('search:global', { query, limit: 10 })).filter((h) => h.type === 'document');
const docs = () => app.services.database.sqlite.prepare("SELECT id, status FROM documents WHERE status != 'ignored'").all() as { id: string; status: string }[];

async function archive(id: string, mode: 'index_only' | 'copy') {
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode, categoryPath: 'work/notes' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
}

/** A file in a scan folder, scanned, analysed and archived with `mode`. */
async function scannedAndArchived(mode: 'index_only' | 'copy'): Promise<{ file: string; id: string; scan: () => Promise<void> }> {
  const dl = path.join(app.home, 'Downloads');
  const file = app.file('Downloads/reise.txt', OLD);
  await app.ok('scanner:addDirectory', { path: dl, recursive: true });
  const scan = async () => {
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
  };
  await scan();
  const scanned = (await app.ok('scanner:getResults', {})).files.find((f) => f.name === 'reise.txt')!;
  await app.ok('scanner:analyze', { fileIds: [scanned.id], confirmLlm: true });
  await app.services.jobs.whenIdle();
  const id = app.services.scanner.getResults({}).files.find((f) => f.name === 'reise.txt')!.documentId!;
  await archive(id, mode);
  return { file, id, scan };
}

describe('index-only document whose original changes', () => {
  it('is re-read in place by the next scan: new content searchable, old content gone, no second document', async () => {
    const { file, id, scan } = await scannedAndArchived('index_only');
    expect((await hits('Zebrastreifen')).map((h) => h.id)).toEqual([id]);

    fs.writeFileSync(file, NEW);
    await scan();

    expect(docs()).toEqual([{ id, status: 'indexed_only' }]);
    expect(await hits('Zebrastreifen')).toHaveLength(0);
    expect((await hits('Giraffenwiese')).map((h) => h.id)).toEqual([id]);
    const doc = await app.ok('documents:get', { id });
    expect(doc.title).toBe('Reiseplanung'); // metadata and assignments stay
    const scanned = app.services.scanner.getResults({}).files.find((f) => f.name === 'reise.txt')!;
    expect(scanned.status).toBe('archived');
    const audit = await app.ok('audit:list', {});
    expect(audit.some((a) => a.action === 'document.refresh' && a.entityIds.includes(id))).toBe(true);
    // analysing the file again changes nothing: it is up to date
    const calls = app.llm.calls.length;
    await app.ok('scanner:analyze', { fileIds: [scanned.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    expect(docs()).toHaveLength(1);
    expect(app.llm.calls.length).toBe(calls);
  });

  it('outside a scan folder is re-read by the archive check when its size changed', async () => {
    const src = app.file('in/reise.txt', OLD);
    const id = (await app.ok('documents:import', { paths: [src] })).imported[0]!.id;
    await app.services.jobs.whenIdle();
    await archive(id, 'index_only');
    fs.writeFileSync(src, NEW);
    await app.services.consistency.run('manual');
    expect(await hits('Zebrastreifen')).toHaveLength(0);
    expect((await hits('Giraffenwiese')).map((h) => h.id)).toEqual([id]);
    // opening shows the current original, not the stale inbox copy
    const row = app.services.documents.getRow(id);
    expect(row.stagedPath).toBeNull();
    expect(fs.readFileSync(app.services.documents.readablePath(row), 'utf8')).toBe(NEW);
  });
});

describe('index-only document whose original vanished', () => {
  it('becomes a hint in the archive check, which closes once the original is back', async () => {
    const { file, id } = await scannedAndArchived('index_only');
    const content = fs.readFileSync(file);
    fs.rmSync(file);
    await app.services.consistency.run('manual');
    const open = () => app.services.insights.list('open').filter((i) => i.title.startsWith('Original fehlt'));
    expect(open()).toHaveLength(1);
    expect(open()[0]!.affected.map((a) => a.id)).toEqual([id]);
    expect(open()[0]!.explanation).toContain(file);

    fs.writeFileSync(file, content);
    await app.services.consistency.run('manual');
    expect(open()).toHaveLength(0);
  });
});

describe('archived document whose original changes', () => {
  it('analysing the changed file creates a new document proposed as replacing the archived one', async () => {
    const { file, id, scan } = await scannedAndArchived('copy');
    fs.writeFileSync(file, NEW);
    await scan();
    const scanned = app.services.scanner.getResults({}).files.find((f) => f.name === 'reise.txt')!;
    expect(scanned.status).toBe('changed');
    await app.ok('scanner:analyze', { fileIds: [scanned.id], confirmLlm: true });
    await app.services.jobs.whenIdle();

    const newer = docs().find((d) => d.id !== id)!;
    expect(newer.status).toBe('proposed');
    const rel = app.services.graph.relationsOf(newer.id, { types: ['supersedes'] }).find((r) => r.sourceEntityId === newer.id);
    expect(rel).toMatchObject({ targetEntityId: id, status: 'proposed' });
    // the archived document itself is untouched
    expect((await hits('Zebrastreifen')).map((h) => h.id)).toEqual([id]);
  });
});
