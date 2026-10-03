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
