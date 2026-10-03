import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CategoryMigrationPlan, CategoryMigrationResult } from '@archivist/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { permissionError } from '../util/errors';
import { resolveInside } from '../util/paths';
import type { ArchiveService } from './archive';
import { FOLDERS_RESTORE_UNDO } from './archive-maintenance';
import { archiveRootOf, type RelocateRequest } from './archive-model';
import type { AuditService } from './audit';
import { LEGACY_MAIN_CATEGORIES, type CategoryService } from './categories';
import type { SettingsService } from './settings';

const TRIGGER = 'category_migration';

/** The German path for a path below an English main category; undefined for every other path. */
export function germanCategoryPath(categoryPath: string): string | undefined {
  const [main = '', ...rest] = categoryPath.split('/');
  const german = LEGACY_MAIN_CATEGORIES[main.toLowerCase()];
  return german ? [german, ...rest].join('/') : undefined;
}

const mainOf = (categoryPath: string) => categoryPath.split('/')[0]!;

export interface CategoryMigrationDeps {
  ctx: AppContext;
  settings: SettingsService;
  categories: CategoryService;
  archive: ArchiveService;
  audit: AuditService;
}

interface ArchivedFile {
  id: string;
  target: string;
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

  /** Level 2: renames the main categories and moves their files; files that cannot move without a conflict stay and are reported. */
  async migrate(opts: { confirmed: boolean }): Promise<CategoryMigrationResult> {
    if (!opts.confirmed) throw permissionError('Das Umbenennen der Hauptkategorien muss ausdrücklich bestätigt werden.');
    const { summary, movable, legacyEntries } = await this.plan();
    for (const { to } of summary.renames) this.deps.categories.create(to, { confirmed: true });
    const relocated = movable.length ? await this.deps.archive.relocate(movable, { confirmed: true, trigger: TRIGGER }) : undefined;
    const removedEntries = await this.renameEntries(legacyEntries);
    const moved = relocated?.success ?? 0;
    this.deps.audit.log({
      action: 'category.migrate',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      before: { renames: summary.renames },
      after: { moved, notMoved: summary.notMoved.length, removedEntries },
      ...(removedEntries.length ? { undo: { type: FOLDERS_RESTORE_UNDO, data: { paths: removedEntries } } } : {}),
    });
    this.deps.ctx.events.changed('documents', 'knowledge', 'audit', 'status');
    return { moved, notMoved: summary.notMoved, categoryEntriesRenamed: legacyEntries.length, failed: (relocated?.failed ?? 0) + (relocated?.conflicts ?? 0) };
  }

  private async plan(): Promise<Plan> {
    const legacyEntries = this.deps.categories
      .list()
      .map((c) => c.path)
      .filter((p) => germanCategoryPath(p));
    const files = this.archivedFiles();
    const movedIds = new Set(files.map((f) => f.id));
    const withoutFile = this.db
      .select({ id: documents.id, categoryPath: documents.categoryPath })
      .from(documents)
      .where(isNotNull(documents.categoryPath))
      .all()
      .filter((row) => !movedIds.has(row.id) && germanCategoryPath(row.categoryPath!)).length;
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

  /** Archived documents with a file inside an English main category, with the German folder they move to. */
  private archivedFiles(): ArchivedFile[] {
    const rows = this.db
      .select()
      .from(documents)
      .where(and(eq(documents.status, 'archived'), isNotNull(documents.archiveRelPath)))
      .all();
    return rows.flatMap((row) => {
      if (row.archiveMode === 'index_only') return [];
      const folder = path.posix.dirname(row.archiveRelPath!);
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
