import fs from 'node:fs';
import path from 'node:path';
import type { RelinkResult } from '@archivist/shared';
import { and, eq } from 'drizzle-orm';
import { documents } from '../db/schema';
import { untrackedFiles } from './archive-inbox-sweep';
import { archivePathOf, archiveRootOf, toPosix } from './archive-model';
import type { ArchiveDeps } from './archive-deps';

export interface RelinkUndoData {
  documentId: string;
  fromRel: string;
  toRel: string;
  sha256: string;
}

/** Size of a file found while listing; null when it vanished meanwhile. */
function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

type MissingDocument = Pick<typeof documents.$inferSelect, 'id' | 'title' | 'sha256' | 'size' | 'archiveRelPath'>;

/** Re-attaches archive files that were renamed or moved outside Archivist: an unknown file with the checksum of a missing one. */
export class ArchiveRelinker {
  constructor(private readonly deps: ArchiveDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async relink(): Promise<RelinkResult> {
    const root = archiveRootOf(this.deps);
    const archived = this.db
      .select({ id: documents.id, title: documents.title, sha256: documents.sha256, size: documents.size, archiveRelPath: documents.archiveRelPath })
      .from(documents)
      .where(eq(documents.status, 'archived'))
      .all()
      .filter((row) => row.archiveRelPath);
    const missing = archived.filter((row) => !fs.existsSync(archivePathOf(root, row.archiveRelPath!)));
    if (missing.length === 0) return { relinked: [], stillMissing: 0 };
    const known = new Set(archived.map((row) => path.resolve(archivePathOf(root, row.archiveRelPath!))));
    const candidates = (await untrackedFiles(root, known)).flatMap((file) => {
      const size = fileSize(file);
      return size === null ? [] : [{ file, size }];
    });
    const relinked: RelinkResult['relinked'] = [];
    const taken = new Set<string>();
    for (const row of missing) {
      const file = await this.findCopy(row, { candidates, taken });
      if (!file) continue;
      taken.add(file);
      const entry = this.attach(row, toPosix(path.relative(root, file)));
      if (entry) relinked.push(entry);
    }
    if (relinked.length > 0) this.deps.ctx.events.changed('documents', 'audit', 'status');
    return { relinked, stillMissing: missing.length - relinked.length };
  }

  /** An unclaimed unknown file of the same size whose checksum matches. */
  private async findCopy(row: MissingDocument, search: { candidates: Array<{ file: string; size: number }>; taken: Set<string> }): Promise<string | null> {
    for (const { file, size } of search.candidates) {
      if (search.taken.has(file) || size !== row.size) continue;
      const hash = await this.deps.pool.run('hashFile', { path: file }, { priority: 'user' }).catch((err: unknown) => {
        this.deps.ctx.logger.warn('archive', 'Relink candidate could not be hashed', { path: file, error: err });
        return null;
      });
      if (hash === row.sha256) return file;
    }
    return null;
  }

  /** Points the document at the found file and logs it with undo (its own timestamp stays); null when another document took the file meanwhile. */
  private attach(row: MissingDocument, toRel: string): RelinkResult['relinked'][number] | null {
    const fromRel = row.archiveRelPath!;
    const undoData: RelinkUndoData = { documentId: row.id, fromRel, toRel, sha256: row.sha256 };
    const root = archiveRootOf(this.deps);
    const attached = this.deps.ctx.database.transaction(() => {
      // e.g. an archiving that ran while the candidates were hashed
      if (this.db.select({ id: documents.id }).from(documents).where(eq(documents.archiveRelPath, toRel)).get()) return false;
      this.db.update(documents).set({ archiveRelPath: toRel }).where(eq(documents.id, row.id)).run();
      this.deps.audit.log({
        action: 'archive.relink',
        actor: 'user',
        trigger: 'manual',
        confirmed: true,
        entityIds: [row.id],
        paths: [archivePathOf(root, fromRel), archivePathOf(root, toRel)],
        before: { archiveRelPath: fromRel },
        after: { archiveRelPath: toRel },
        undo: { type: 'archive_relink', data: undoData },
      });
      return true;
    });
    return attached ? { documentId: row.id, title: row.title, path: archivePathOf(root, toRel) } : null;
  }

  async undoCheck(d: RelinkUndoData): Promise<string[]> {
    const row = this.db
      .select({ archiveRelPath: documents.archiveRelPath })
      .from(documents)
      .where(and(eq(documents.id, d.documentId), eq(documents.status, 'archived')))
      .get();
    if (!row) return ['Das Dokument ist nicht mehr archiviert.'];
    if (row.archiveRelPath !== d.toRel) return ['Das Dokument verweist inzwischen auf eine andere Datei.'];
    return [];
  }

  async undoRun(d: RelinkUndoData): Promise<string> {
    this.db.update(documents).set({ archiveRelPath: d.fromRel }).where(eq(documents.id, d.documentId)).run();
    this.deps.ctx.events.changed('documents', 'status');
    return 'Verknüpfung rückgängig gemacht; die Archivdatei gilt wieder als fehlend, bis sie am alten Ort liegt.';
  }
}
