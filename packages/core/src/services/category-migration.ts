import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CategoryMigrationPlan, CategoryMigrationResult, Job } from '@archivist/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { progressLine } from '../util/bulk-text';
import { permissionError } from '../util/errors';
import { resolveInside } from '../util/paths';
import type { ArchiveService } from './archive';
import { FOLDERS_RESTORE_UNDO } from './archive-maintenance';
import { archiveRootOf, type RelocateRequest } from './archive-model';
import type { AuditService } from './audit';
import { LEGACY_MAIN_CATEGORIES, type CategoryService } from './categories';
import { isJobCancelled, type JobContext, type JobQueueService } from './jobs';
import type { SettingsService } from './settings';

const TRIGGER = 'category_migration';

/** Job type of the migration: moves file by file, so a cancel stops between two files (#233). */
export const CATEGORY_MIGRATION_JOB = 'categories.migrate';

/** The German path for a path below an English main category; undefined for every other path. */
export function germanCategoryPath(categoryPath: string): string | undefined {
  const [main = '', ...rest] = categoryPath.split('/');
  const german = LEGACY_MAIN_CATEGORIES[main.toLowerCase()];
  return german ? [german, ...rest].join('/') : undefined;
}

const mainOf = (categoryPath: string) => categoryPath.split('/')[0]!;

/** Archived with its own file in the archive, not only indexed. */
const hasArchiveFile = (row: Pick<typeof documents.$inferSelect, 'status' | 'archiveRelPath' | 'archiveMode'>) =>
  row.status === 'archived' && row.archiveRelPath !== null && row.archiveMode !== 'index_only';

export interface CategoryMigrationDeps {
  ctx: AppContext;
  settings: SettingsService;
  categories: CategoryService;
  archive: ArchiveService;
  audit: AuditService;
  jobs: JobQueueService;
}

interface ArchivedFile {
  id: string;
  target: string;
}

interface MigrationProgress {
  moved: number;
  failed: number;
}

interface Plan {
  summary: CategoryMigrationPlan;
  movable: RelocateRequest[];
  legacyEntries: string[];
}

/** One-time, user-triggered rename of `work`/`private` to `Arbeit`/`Privat`: files move through the undoable relocation, nothing is overwritten (#233). */
export class CategoryMigrationService {
  constructor(private readonly deps: CategoryMigrationDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Preview: changes nothing. */
  async preview(): Promise<CategoryMigrationPlan> {
    return (await this.plan()).summary;
  }

  /** Level 3 (it moves nearly the whole archive): queues the migration as one job, only with both confirmations. */
  enqueue(request: { confirmed: boolean; strongConfirmed: boolean }): Job {
    if (!request.confirmed || !request.strongConfirmed)
      throw permissionError('Das Umbenennen der Hauptkategorien verschiebt fast das ganze Archiv und erfordert eine zweite, ausdrückliche Bestätigung.');
    return this.deps.jobs.enqueue(CATEGORY_MIGRATION_JOB, { label: 'Hauptkategorien auf Deutsch umstellen', sameAs: () => true, maxAttempts: 1 });
  }

  /** Renames the main categories and moves their files one by one; a cancelled run keeps what moved, a re-run plans again and moves the rest. */
  async run(job: JobContext<Record<string, never>>): Promise<CategoryMigrationResult & { summary: string }> {
    const { summary, movable, legacyEntries } = await this.plan();
    for (const { to } of summary.renames) this.deps.categories.create(to, { confirmed: true });
    const progress: MigrationProgress = { moved: 0, failed: 0 };
    try {
      await this.moveFiles(movable, { job, progress });
    } catch (err) {
      if (isJobCancelled(err)) this.log(summary, { progress, removedEntries: [] });
      throw err;
    }
    const removedEntries = await this.renameEntries(legacyEntries);
    this.log(summary, { progress, removedEntries });
    const result = { ...progress, notMoved: summary.notMoved, categoryEntriesRenamed: legacyEntries.length };
    return { ...result, summary: resultText(result) };
  }

  private async moveFiles(movable: RelocateRequest[], run: { job: JobContext<Record<string, never>>; progress: MigrationProgress }): Promise<void> {
    const { job, progress } = run;
    const started = Date.now();
    for (const [index, request] of movable.entries()) {
      job.throwIfCancelled();
      const relocated = await this.deps.archive.relocate([request], { confirmed: true, trigger: TRIGGER });
      progress.moved += relocated.success;
      progress.failed += relocated.failed + relocated.conflicts;
      job.report((index + 1) / movable.length, progressLine({ done: index + 1, total: movable.length, elapsedMs: Date.now() - started, verb: 'verschoben' }));
    }
  }

  private log(summary: CategoryMigrationPlan, outcome: { progress: MigrationProgress; removedEntries: string[] }): void {
    const { progress, removedEntries } = outcome;
    this.deps.audit.log({
      action: 'category.migrate',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      before: { renames: summary.renames },
      after: { moved: progress.moved, notMoved: summary.notMoved.length, removedEntries },
      ...(removedEntries.length ? { undo: { type: FOLDERS_RESTORE_UNDO, data: { paths: removedEntries } } } : {}),
    });
    this.deps.ctx.events.changed('documents', 'knowledge', 'audit', 'status');
  }

  private async plan(): Promise<Plan> {
    const legacyEntries = this.deps.categories
      .list()
      .map((c) => c.path)
      .filter((p) => germanCategoryPath(p));
    const files = this.archivedFiles();
    const withoutFile = this.db
      .select({ status: documents.status, archiveRelPath: documents.archiveRelPath, archiveMode: documents.archiveMode, categoryPath: documents.categoryPath })
      .from(documents)
      .where(isNotNull(documents.categoryPath))
      .all()
      .filter((row) => !hasArchiveFile(row) && germanCategoryPath(row.categoryPath!)).length;
    const mains = new Set([...legacyEntries, ...files.map((f) => f.target)].map((p) => mainOf(p).toLowerCase()));
    const renames = Object.entries(LEGACY_MAIN_CATEGORIES)
      .filter(([legacy, german]) => mains.has(legacy) || mains.has(german.toLowerCase()))
      .map(([from, to]) => ({ from, to }));
    const requests = files.map((f) => ({ documentId: f.id, categoryPath: f.target, confirmedMainCategory: mainOf(f.target) }));
    const notMoved = (await this.deps.archive.previewRelocate(requests))
      .filter((item) => item.blocked || item.renamed)
      .map((item) => ({
        documentId: item.documentId,
        title: item.title,
        from: item.fromRelPath,
        reason: item.conflicts.join(' ') || 'Die Datei kann nicht verschoben werden.',
      }));
    const staying = new Set(notMoved.map((item) => item.documentId));
    const movable = requests.filter((request) => !staying.has(request.documentId));
    const summary = { renames, documentsToMove: movable.length, categoryEntries: legacyEntries.length, notMoved, withoutFile };
    return { summary, movable, legacyEntries };
  }

  /** Archived documents whose file lies inside an English main category, with the German folder they move to; files elsewhere stay. */
  private archivedFiles(): ArchivedFile[] {
    const rows = this.db
      .select()
      .from(documents)
      .where(and(eq(documents.status, 'archived'), isNotNull(documents.archiveRelPath)))
      .all();
    return rows.flatMap((row) => {
      const folder = path.posix.dirname(row.archiveRelPath!);
      if (!hasArchiveFile(row) || !germanCategoryPath(folder)) return [];
      const target = germanCategoryPath(germanCategoryPath(row.categoryPath ?? '') ? row.categoryPath! : folder);
      return target ? [{ id: row.id, target }] : [];
    });
  }

  /** Creates the German entry for every English one; removes the English entry when no document or file uses it any more. */
  private async renameEntries(entries: string[]): Promise<string[]> {
    for (const entry of entries) this.deps.categories.create(germanCategoryPath(entry)!, { confirmed: true });
    const used = this.db.select({ categoryPath: documents.categoryPath, archiveRelPath: documents.archiveRelPath }).from(documents).all();
    const within = (candidate: string | null, entry: string) => candidate === entry || Boolean(candidate?.startsWith(`${entry}/`));
    const inUse = (entry: string) =>
      used.some((row) => within(row.categoryPath, entry) || within(row.archiveRelPath ? path.posix.dirname(row.archiveRelPath) : null, entry));
    const removed: string[] = [];
    for (const entry of entries.toSorted((a, b) => b.length - a.length)) {
      if (inUse(entry) || !(await this.removeFolderIfEmpty(entry))) continue;
      this.deps.categories.remove(entry);
      removed.push(entry);
    }
    return removed;
  }

  private async removeFolderIfEmpty(categoryPath: string): Promise<boolean> {
    const absolute = resolveInside(archiveRootOf(this.deps), categoryPath);
    if (!fs.existsSync(absolute)) return true;
    if ((await fsp.readdir(absolute)).length) return false;
    await fsp.rmdir(absolute);
    return true;
  }
}

function resultText(result: CategoryMigrationResult): string {
  const failed = result.failed > 0 ? `, ${result.failed} Verschiebung(en) sind fehlgeschlagen` : '';
  const notMoved = result.notMoved.length > 0 ? `, ${result.notMoved.length} Datei(en) bleiben wegen eines Konflikts` : '';
  return `${result.moved} Datei(en) verschoben, ${result.categoryEntriesRenamed} Kategorie-Einträge umbenannt${failed}${notMoved}. Du kannst das im Änderungsprotokoll rückgängig machen.`;
}
