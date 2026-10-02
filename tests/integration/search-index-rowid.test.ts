import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../packages/core/src/db/database';
import { Logger } from '../../packages/core/src/util/logger';
import { createTestApp, MIGRATIONS, type TestApp } from '../helpers/harness';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.cleanup();
  app = null;
});

type RowPair = { chunkRowid: number; ftsRowid: number | null };
const pairs = (sqlite: DatabaseService['sqlite']) =>
  sqlite.prepare('SELECT c.rowid AS chunkRowid, (SELECT f.rowid FROM search_fts f WHERE f.chunk_id = c.id) AS ftsRowid FROM chunks c').all() as RowPair[];

describe('Search index: FTS rows are deleted by rowid (#212)', () => {
  it('FTS rows carry the rowid of their chunk; re-indexing replaces only the own rows', async () => {
    app = await createTestApp({ privacy: 'auto' });
    const search = app.services.search;
    await search.index({ type: 'note', id: 'a', title: 'A', content: 'Heizung Wartung Vertrag' });
    await search.index({ type: 'note', id: 'b', title: 'B', content: 'Solaranlage Dach' });
    await search.index({ type: 'note', id: 'a', title: 'A', content: 'Heizung Wartung neu' });

    const sqlite = app.services.ctx.database.sqlite;
    const rows = pairs(sqlite);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ftsRowid).toBe(r.chunkRowid);
    const fts = sqlite.prepare('SELECT entity_id AS e, content FROM search_fts ORDER BY entity_id').all() as Array<{ e: string; content: string }>;
    expect(fts).toEqual([
      { e: 'a', content: expect.stringContaining('neu') },
      { e: 'b', content: expect.stringContaining('Solaranlage') },
    ]);

    search.remove('a');
    expect((sqlite.prepare('SELECT entity_id AS e FROM search_fts').all() as Array<{ e: string }>).map((r) => r.e)).toEqual(['b']);
  });

  it('the migration re-keys FTS rows of an existing index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-fts-'));
    try {
      // migrations up to 0015 = the state before the change
      const old = path.join(dir, 'migrations');
      fs.cpSync(MIGRATIONS, old, { recursive: true });
      const journalFile = path.join(old, 'meta', '_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter((e) => e.tag < '0016');
      fs.writeFileSync(journalFile, JSON.stringify(journal));

      const db = new DatabaseService(path.join(dir, 'a.db'), new Logger(null));
      db.migrate(old);
      const insChunk = db.sqlite.prepare("INSERT INTO chunks (id, entity_type, entity_id, idx, text) VALUES (?, 'note', ?, 0, ?)");
      const insFts = db.sqlite.prepare("INSERT INTO search_fts (rowid, chunk_id, entity_id, entity_type, title, content) VALUES (?, ?, ?, 'note', 'T', ?)");
      insChunk.run('c1', 'n1', 'eins');
      insChunk.run('c2', 'n2', 'zwei');
      // old rows: rowids unrelated to the chunks
      insFts.run(500, 'c1', 'n1', 'eins');
      insFts.run(501, 'c2', 'n2', 'zwei');

      db.migrate(MIGRATIONS);

      const rows = pairs(db.sqlite);
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.ftsRowid).toBe(r.chunkRowid);
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'zwei'").get()).toEqual({ n: 1 });
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Near-duplicate lookup uses an indexed column (#212)', () => {
  it('finds a document with the same text start via documents.text_hash', async () => {
    app = await createTestApp({ privacy: 'local_only' });
    const text = 'Mietvertrag über die Wohnung in der Musterstraße 1, abgeschlossen zwischen Anna und der Hausverwaltung. '.repeat(5);
    const first = await app.ok('documents:import', { paths: [app.file('in/a.txt', text)] });
    await app.services.jobs.whenIdle();
    const second = await app.ok('documents:import', { paths: [app.file('in/b.txt', `${text} `)] });
    await app.services.jobs.whenIdle();

    const doc = await app.ok('documents:get', { id: second.imported[0]!.id });
    expect(doc.proposal?.duplicateOfDocumentId).toBe(first.imported[0]!.id);
    const plan = app.services.ctx.database.sqlite
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM documents WHERE text_hash = ? AND id != ? AND status IN ('archived','indexed_only','proposed')")
      .all('x', 'y') as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/documents_text_hash_idx/);
  });
});
