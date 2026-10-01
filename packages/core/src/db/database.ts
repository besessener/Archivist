import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface MigrationStatus {
  applied: number;
  total: number;
  upToDate: boolean;
}

/** Besitzt die SQLite-Verbindung (better-sqlite3) und das Drizzle-Handle. */
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
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.db = drizzle(this.sqlite, { schema });
  }

  /** MigrationService-Aufgabe: Drizzle-Migrationen aus dem Ordner anwenden. */
  migrate(migrationsFolder: string): MigrationStatus {
    try {
      migrate(this.db, { migrationsFolder });
    } catch (err) {
      this.logger.error('migration', 'Migration fehlgeschlagen', { error: err });
      throw new AppError('database_error', 'Die Datenbankmigration ist fehlgeschlagen.', { cause: err, details: err instanceof Error ? err.message : String(err) });
    }
    return this.migrationStatus(migrationsFolder);
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

  /** Konsistentes Online-Backup über die SQLite-Backup-API (nicht per Dateikopie). */
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
