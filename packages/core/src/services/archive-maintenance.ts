import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VerifyReport } from '@archivist/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { documents } from '../db/schema';
import { isInside, resolveInside } from '../util/paths';
import { hasChecksum } from './archive-files';
import { archivePathOf, archiveRootOf } from './archive-model';
import type { ArchiveDeps } from './archive-deps';
import { sweepOrphanInboxCopies, untrackedFiles } from './archive-inbox-sweep';

export const FOLDERS_RESTORE_UNDO = 'category_restore';

type DocumentRow = typeof documents.$inferSelect;

/** Every folder (and its parent folders) that holds an archived file, as relative POSIX paths. */
function usedFolders(rels: string[]): Set<string> {
  return new Set(
    rels.flatMap((rel) => {
      const parts = path.posix.dirname(rel).split('/');
      return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    }),
  );
}

/** Keeping the archive tidy and consistent: pending inbox copies, empty folders, database against file system. */
export class ArchiveMaintenance {
  constructor(private readonly deps: ArchiveDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Removes inbox copies left after archiving, only when unchanged and the archive file is intact; never throws, returns the count. */
  async cleanupInbox(): Promise<number> {
    let cleaned = 0;
    try {
      const pending = this.db
        .select()
        .from(documents)
        .where(and(eq(documents.status, 'archived'), isNotNull(documents.stagedPath)))
        .all();
      for (const row of pending) {
        if (!(await this.inboxCopyGone(row))) continue;
        // updatedAt stays: this completes the archiving itself, so its undo must remain possible
        this.db.update(documents).set({ stagedPath: null }).where(eq(documents.id, row.id)).run();
        cleaned += 1;
      }
      // a restore of a running undo looks like an orphan until its commit: sweep only while no file operation runs
      await this.deps.locks.exclusive(async () => {
        cleaned += await sweepOrphanInboxCopies(this.deps);
      });
    } catch (err) {
      this.deps.ctx.logger.error('archive', 'Inbox cleanup failed', { error: err });
    }
    if (cleaned > 0) {
      this.deps.ctx.logger.info('archive', 'Removed pending inbox copies', { count: cleaned });
      this.deps.ctx.events.changed('documents');
    }
    return cleaned;
  }

  /** Removes the pending inbox copy of an archived document if that is safe; true when it is gone now. */
  private async inboxCopyGone(row: DocumentRow): Promise<boolean> {
    const staged = row.stagedPath!;
    if (!row.archiveRelPath || !isInside(this.deps.ctx.paths.inbox, staged)) return false;
    if (!(await hasChecksum(archivePathOf(archiveRootOf(this.deps), row.archiveRelPath), row.sha256))) return false; // keep the only intact copy
    if (!fs.existsSync(staged)) return true;
    if (!(await hasChecksum(staged, row.sha256))) return false;
    return this.deps.files.removeCreated(staged); // still locked: next attempt later
  }

  /** Removes empty folders of the archive (no file, no document) and their category entries; returns the removed paths. */
  async removeEmptyFolders(): Promise<string[]> {
    const rels = this.db
      .select({ rel: documents.archiveRelPath })
      .from(documents)
      .where(isNotNull(documents.archiveRelPath))
      .all()
      .map((r) => r.rel!);
    const used = usedFolders(rels);
    const removed: string[] = [];
    for (const category of this.deps.categories.list().toSorted((a, b) => b.path.length - a.path.length)) {
      if (used.has(category.path) || !category.path.includes('/')) continue;
      if (await this.removeFolder(category.path)) removed.push(category.path);
    }
    if (removed.length)
      this.deps.audit.log({
        action: 'category.removeEmpty',
        actor: 'user',
        trigger: 'manual',
        confirmed: true,
        paths: removed,
        after: { removed },
        undo: { type: FOLDERS_RESTORE_UNDO, data: { paths: removed } },
      });
    return removed;
  }

  /** Removes an empty (or missing) category folder and its entry; false when it is not empty or locked. */
  private async removeFolder(categoryPath: string): Promise<boolean> {
    const abs = resolveInside(archiveRootOf(this.deps), categoryPath);
    try {
      if (fs.existsSync(abs)) {
        if ((await fsp.readdir(abs)).length) return false;
        await fsp.rmdir(abs);
      }
      this.deps.categories.remove(categoryPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Compares the database and file system state of the archive. */
  async verify(): Promise<VerifyReport> {
    const root = archiveRootOf(this.deps);
    const rows = this.db
      .select()
      .from(documents)
      .where(inArray(documents.status, ['archived']))
      .all();
    const report: VerifyReport = { checkedDocuments: rows.length, missingFiles: [], changedFiles: [], untrackedFiles: [], ok: true };
    const known = new Set<string>();
    for (const row of rows) {
      if (!row.archiveRelPath) continue;
      const abs = archivePathOf(root, row.archiveRelPath);
      known.add(path.resolve(abs));
      if (!fs.existsSync(abs)) report.missingFiles.push({ documentId: row.id, title: row.title, path: abs });
      else if ((await this.deps.pool.run('hashFile', { path: abs })) !== row.sha256)
        report.changedFiles.push({ documentId: row.id, title: row.title, path: abs });
    }
    report.untrackedFiles.push(...(await untrackedFiles(root, known)));
    report.ok = report.missingFiles.length === 0 && report.changedFiles.length === 0;
    return report;
  }
}
