import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../packages/core/src/db/database';
import { Logger } from '../../packages/core/src/util/logger';
import { MIGRATIONS } from '../helpers/harness';

// Migrations run unattended against real archives: pending ones get a rollback point, a database from a newer app is refused.

let dir: string;
let backups: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-migration-'));
  backups = path.join(dir, 'backups');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the migrations without the entries after `lastTag`: the app version before a later release. */
function migrationsUpTo(lastTag: string): string {
  const old = path.join(dir, `migrations-${lastTag}`);
  fs.cpSync(MIGRATIONS, old, { recursive: true });
  const journalFile = path.join(old, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= lastTag);
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  return old;
}

const open = () => new DatabaseService(path.join(dir, 'a.db'), new Logger(null));
const snapshots = () => (fs.existsSync(backups) ? fs.readdirSync(backups) : []);

describe('Migration safety (#217)', () => {
  it('a fresh database gets no pre-migration backup', () => {
    const db = open();
    db.migrate(MIGRATIONS, backups);
    db.close();

    expect(snapshots()).toEqual([]);
  });

  it('pending migrations on a populated database are preceded by a readable snapshot', () => {
    const first = open();
    first.migrate(migrationsUpTo('0010'), backups);
    first.sqlite.prepare("insert into categories (id, path, approved, created_at) values ('1','test',1,'now')").run();
    first.close();

    const db = open();
    const status = db.migrate(MIGRATIONS, backups);
    db.close();

    expect(status.upToDate).toBe(true);
    const [snapshot] = snapshots();
    expect(snapshots()).toHaveLength(1);
    const copy = new DatabaseService(path.join(backups, snapshot!), new Logger(null));
    expect(copy.migrationStatus(migrationsUpTo('0010')).applied).toBe(11);
    expect(copy.sqlite.prepare('select count(*) c from categories').get()).toEqual({ c: 1 });
    copy.close();
  });

  it('an up-to-date database is not backed up again', () => {
    const first = open();
    first.migrate(MIGRATIONS, backups);
    first.close();

    const db = open();
    db.migrate(MIGRATIONS, backups);
    db.close();

    expect(snapshots()).toEqual([]);
  });

  it('refuses a database that a newer version of the app has migrated, without touching it', () => {
    const first = open();
    first.migrate(MIGRATIONS, backups);
    first.sqlite.prepare("insert into __drizzle_migrations (hash, created_at) values ('from-the-future', 9999999999999)").run();
    first.close();

    const db = open();

    expect(() => db.migrate(MIGRATIONS, backups)).toThrow(/neueren Version/);
    expect(db.sqlite.prepare('select count(*) c from __drizzle_migrations').get()).toEqual({ c: db.migrationStatus(MIGRATIONS).applied });
    db.close();
  });

  it('refuses to migrate when the snapshot cannot be written, and leaves the database as it was', () => {
    const first = open();
    first.migrate(migrationsUpTo('0010'), backups);
    first.close();
    fs.writeFileSync(backups, 'eine Datei, kein Ordner');

    const db = open();

    expect(() => db.migrate(MIGRATIONS, backups)).toThrow(/keine Sicherung/);
    expect(db.migrationStatus(MIGRATIONS).applied).toBe(11);
    db.close();
  });

  it('keeps only the newest three snapshots', () => {
    fs.mkdirSync(backups, { recursive: true });
    for (const stamp of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.writeFileSync(path.join(backups, `vor-migration-${stamp}.db`), '');
    const first = open();
    first.migrate(migrationsUpTo('0010'), backups);
    first.close();

    const db = open();
    db.migrate(MIGRATIONS, backups);
    db.close();

    expect(snapshots()).toHaveLength(3);
    expect(snapshots()).not.toContain('vor-migration-2020-01-01.db');
  });
});

describe('Damaged database file (#217)', () => {
  const file = () => path.join(dir, 'a.db');

  it('a file that is no database is reported as damaged, with the way out and no stack', () => {
    fs.writeFileSync(file(), 'das ist keine SQLite-Datenbank '.repeat(200));

    expect(() => open()).toThrow(
      expect.objectContaining({ category: 'database_corrupt', message: expect.stringContaining('aus einem Backup wiederherstellen') }),
    );
  });

  it('a populated database with overwritten pages is found by the startup check', () => {
    const first = open();
    first.migrate(MIGRATIONS);
    first.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    first.close();
    const bytes = fs.readFileSync(file());
    const damaged = Buffer.from(bytes);
    for (let i = 8192; i < Math.min(damaged.length, 40_000); i += 1) damaged[i] = (i * 31) % 251;
    fs.writeFileSync(file(), damaged);

    expect(() => open()).toThrow(expect.objectContaining({ category: 'database_corrupt' }));
  });

  it('an intact database opens as before', () => {
    const first = open();
    first.migrate(MIGRATIONS);
    first.close();

    expect(() => open().close()).not.toThrow();
  });
});

describe('Decision participants are optional (#198)', () => {
  it('removes participants from the missing fields of existing decisions and keeps everything else', () => {
    const first = open();
    first.migrate(migrationsUpTo('0024'), backups);
    const insert = first.sqlite.prepare(
      "insert into decisions (id, title, decision_text, status, missing_fields, created_at, updated_at) values (?, 'Entscheidung', 'Text', ?, ?, 'now', 'now')",
    );
    insert.run('only-participants', 'active', '["participants"]');
    insert.run('draft-with-date', 'draft', '["decidedAt","participants","topic"]');
    insert.run('complete', 'active', '[]');
    first.close();

    const db = open();
    db.migrate(MIGRATIONS, backups);
    const rows = db.sqlite.prepare('select id, status, missing_fields as missing from decisions order by id').all();
    db.close();

    expect(rows).toEqual([
      { id: 'complete', status: 'active', missing: '[]' },
      { id: 'draft-with-date', status: 'draft', missing: '["decidedAt","topic"]' },
      { id: 'only-participants', status: 'active', missing: '[]' },
    ]);
  });
});

describe('Full-text index as external content over the chunks (#225)', () => {
  const seedOldIndex = () => {
    const first = open();
    first.migrate(migrationsUpTo('0029'), backups);
    const insertChunk = first.sqlite.prepare("insert into chunks (id, entity_type, entity_id, idx, text) values (?, 'document', ?, 0, ?)");
    const insertFts = first.sqlite.prepare(
      "insert into search_fts (rowid, chunk_id, entity_id, entity_type, title, content) values ((select rowid from chunks where id = ?), ?, ?, 'document', ?, ?)",
    );
    const rows = [
      ['c1', 'd1', 'Mietvertrag Hauptstraße', 'Die Kaution beträgt drei Monatsmieten.'],
      ['c2', 'd2', 'Rechnung', 'Heizung Wartung im Mietvertrag erwähnt.'],
    ] as const;
    for (const [chunk, entity, title, text] of rows) {
      insertChunk.run(chunk, entity, text);
      insertFts.run(chunk, chunk, entity, title, text);
    }
    first.close();
  };

  it('rebuilds the index of a populated database: titles carried over, search, weighting and snippets keep working', () => {
    seedOldIndex();

    const db = open();
    db.migrate(MIGRATIONS, backups);

    expect(db.sqlite.prepare('select id, title from chunks order by id').all()).toEqual([
      { id: 'c1', title: 'Mietvertrag Hauptstraße' },
      { id: 'c2', title: 'Rechnung' },
    ]);
    const ranked = db.sqlite
      .prepare(
        "select entity_id as e, snippet(search_fts, 4, '[', ']', '…', 8) as s from search_fts where search_fts match 'mietvertrag' order by bm25(search_fts, 0, 0, 0, 3.0, 1.0)",
      )
      .all();
    expect(ranked).toEqual([
      { e: 'd1', s: expect.any(String) },
      { e: 'd2', s: expect.stringContaining('[Mietvertrag]') },
    ]);
    expect(db.sqlite.prepare("select chunk_id as c, title as t from search_fts where search_fts match 'kaution'").all()).toEqual([
      { c: 'c1', t: 'Mietvertrag Hauptstraße' },
    ]);
    expect(db.sqlite.prepare("select rowid as r from search_fts where chunk_id = 'c2'").get()).toEqual(
      db.sqlite.prepare("select rowid as r from chunks where id = 'c2'").get(),
    );
    expect(() => db.sqlite.prepare("insert into search_fts (search_fts) values ('integrity-check')").run()).not.toThrow();
    db.close();
  });

  it('keeps no second copy of the text and still drops the rows of a re-indexed entry', () => {
    seedOldIndex();
    const db = open();
    db.migrate(MIGRATIONS, backups);

    const tables = (db.sqlite.prepare("select name from sqlite_master where name like 'search_fts%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).not.toContain('search_fts_content');

    db.sqlite.prepare('delete from search_fts where rowid in (select rowid from chunks where entity_id = ?)').run('d1');
    db.sqlite.prepare('delete from chunks where entity_id = ?').run('d1');
    expect(db.sqlite.prepare("select count(*) as n from search_fts where search_fts match 'kaution'").get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare("select count(*) as n from search_fts where search_fts match 'heizung'").get()).toEqual({ n: 1 });
    expect(() => db.sqlite.prepare("insert into search_fts (search_fts) values ('integrity-check')").run()).not.toThrow();
    db.close();
  });
});
