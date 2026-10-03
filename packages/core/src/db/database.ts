import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

const DATABASE_CORRUPT =
  'Die Datenbank von Archivist ist beschädigt. Deine Dokumente im Archivordner sind davon nicht betroffen. Archivist kann die Datenbank aus einem Backup wiederherstellen.';
/** SQLite result codes (better-sqlite3 error codes) that mean the file itself is damaged. */
const CORRUPT_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_CORRUPT_VTAB', 'SQLITE_CORRUPT_INDEX', 'SQLITE_CORRUPT_SEQUENCE']);

const PRE_MIGRATION_PREFIX = 'vor-migration-';
const PRE_MIGRATION_KEEP = 3;
const NEWER_DATABASE =
  'Die Datenbank stammt von einer neueren Version von Archivist. Bitte installiere die aktuelle Version; die Daten wurden nicht verändert.';

export interface MigrationStatus {
  applied: number;
  total: number;
  upToDate: boolean;
}

/** Owns the SQLite connection (better-sqlite3) and the Drizzle handle. */
export class DatabaseService {
  readonly sqlite: Database.Database;
  readonly db: Db;

  constructor(
    readonly file: string,
    private readonly logger: Logger,
  ) {
    try {
      if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
      this.sqlite = new Database(file);
    } catch (err) {
      throw new AppError('native_module_error', 'SQLite konnte nicht geöffnet werden (natives Modul prüfen).', {
        cause: err,
        details: err instanceof Error ? err.message : String(err),
      });
    }
    this.assertIntact(file);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = FULL'); // WAL+NORMAL does not sync commits; originals are deleted after them
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.db = drizzle(this.sqlite, { schema });
  }

  /** Fails with a recoverable error when SQLite finds the file damaged (a quick structural check, no data is read). */
  private assertIntact(file: string): void {
    if (file === ':memory:') return;
    let problem: string | null = null;
    try {
      const result = this.sqlite.pragma('quick_check(1)', { simple: true });
      if (result !== 'ok') problem = String(result);
    } catch (err) {
      if (!CORRUPT_CODES.has((err as { code?: string }).code ?? '')) throw err;
      problem = err instanceof Error ? err.message : String(err);
    }
    if (problem === null) return;
    this.sqlite.close();
    throw new AppError('database_corrupt', DATABASE_CORRUPT, { details: problem });
  }

  /**
   * MigrationService task: applies the Drizzle migrations from the folder.
   * A database from a newer app version is refused; with `backupDir`, pending migrations are preceded by a snapshot.
   */
  migrate(migrationsFolder: string, backupDir?: string): MigrationStatus {
    const before = this.migrationStatus(migrationsFolder);
    if (before.total > 0 && before.applied > before.total) throw new AppError('database_error', NEWER_DATABASE);
    if (backupDir && before.applied > 0 && before.applied < before.total) this.backupBeforeMigration(backupDir);
    try {
      migrate(this.db, { migrationsFolder });
    } catch (err) {
      this.logger.error('migration', 'Migration failed', { error: err });
      throw new AppError('database_error', 'Die Datenbankmigration ist fehlgeschlagen.', {
        cause: err,
        details: err instanceof Error ? err.message : String(err),
      });
    }
    return this.migrationStatus(migrationsFolder);
  }

  /** Snapshot of the populated database (VACUUM INTO, synchronous) as the rollback point for the pending migrations; keeps the newest few. */
  private backupBeforeMigration(backupDir: string): void {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
      this.sqlite.prepare('VACUUM INTO ?').run(path.join(backupDir, `${PRE_MIGRATION_PREFIX}${stamp}.db`));
      const old = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith(PRE_MIGRATION_PREFIX))
        .toSorted();
      for (const file of old.slice(0, -PRE_MIGRATION_KEEP)) fs.rmSync(path.join(backupDir, file), { force: true });
    } catch (err) {
      this.logger.error('migration', 'Backup before migration failed', { error: err });
      throw new AppError(
        'database_error',
        'Vor der Datenbankmigration konnte keine Sicherung angelegt werden; Archivist startet nicht, damit nichts verloren geht.',
        {
          cause: err,
          details: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  migrationStatus(migrationsFolder: string): MigrationStatus {
    let total: number;
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
      total = journal.entries.length;
    } catch {
      total = 0;
    }
    let applied: number;
    try {
      applied = (this.sqlite.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get() as { c: number }).c;
    } catch {
      applied = 0;
    }
    return { applied, total, upToDate: applied >= total };
  }

  /** Consistent online backup via the SQLite backup API (not via file copy). */
  async backupTo(dest: string): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await this.sqlite.backup(dest);
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close();
  }
}
