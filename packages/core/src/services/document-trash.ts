import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { TrashEntry } from '@archivist/shared';
import { eq, inArray } from 'drizzle-orm';
import { documents, scanFiles } from '../db/schema';
import { AppError, permissionError } from '../util/errors';
import { sha256File } from '../util/hash';
import { isInside } from '../util/paths';
import { ArchiveFileOps, pruneEmptyDirs, type MovedFile } from './archive-files';
import type { DocRow, DocumentDeps } from './document-model';
import type { NodeSnapshot } from './knowledge-graph';
import type { UndoService } from './undo';

export const DOCUMENT_TRASH_UNDO = 'document_trash';

/** The archive's file locks: no trash move while the same document is archived, or the archive is moved or backed up. */
export interface FileOperationLock {
  guardedFor<T>(documentId: string, operation: () => Promise<T>): Promise<T>;
}
const titleOf = (before: unknown): string => {
  const title = (before as { title?: unknown } | null)?.title;
  return typeof title === 'string' ? title : '';
};
const trashMove = (file: TrashedFile): MovedFile => ({ moved: file.trashed, original: file.original, sha256: file.sha256 });
const TRASH_ACTION = 'document.trash';

/** A file of the document in the trash; `archive` goes back below the current archive root, `staged` to its own path. */
interface TrashedFile {
  kind: 'archive' | 'staged';
  original: string;
  trashed: string;
  sha256: string;
}

interface DocumentTrashUndo {
  row: DocRow;
  scanFileIds: string[];
  node: NodeSnapshot | null;
  files: TrashedFile[];
}

/** Deleting with a safety net: documents go to the trash (undoable); only emptying the trash deletes for good. */
export class DocumentTrash {
  private readonly files: ArchiveFileOps;

  constructor(
    private readonly deps: DocumentDeps,
    private readonly lock: () => FileOperationLock,
  ) {
    this.files = new ArchiveFileOps(deps.ctx);
  }

  registerUndo(undo: UndoService): void {
    undo.register(DOCUMENT_TRASH_UNDO, {
      check: async (data) => this.restoreConflicts(data as DocumentTrashUndo),
      run: async (data) => this.lock().guardedFor((data as DocumentTrashUndo).row.id, () => this.restore(data as DocumentTrashUndo)),
    });
  }

  /** Moves the archive file and the own inbox copy into the trash and removes the document; the user's original stays. */
  moveToTrash(request: { id: string; trigger: string }): Promise<{ auditId: string }> {
    return this.lock().guardedFor(request.id, () => this.trashDocument(request));
  }

  private async trashDocument(request: { id: string; trigger: string }): Promise<{ auditId: string }> {
    const { ctx, documents: access, graph, search, audit } = this.deps;
    const row = access.getRow(request.id);
    const trashed = await this.trashFiles(row);
    const undoData: DocumentTrashUndo = { row, scanFileIds: this.scanFileIdsOf(row.id), node: graph.snapshotNode(row.id), files: trashed };
    try {
      ctx.database.transaction(() => {
        ctx.database.db.update(scanFiles).set({ documentId: null }).where(eq(scanFiles.documentId, row.id)).run();
        ctx.database.db.delete(documents).where(eq(documents.id, row.id)).run();
        graph.removeNode(row.id);
      });
    } catch (err) {
      await this.putBackAll(trashed.map(trashMove));
      throw err;
    }
    search.remove(row.id);
    const auditId = audit.log({
      action: TRASH_ACTION,
      actor: 'user',
      trigger: request.trigger,
      confirmed: true,
      entityIds: [row.id],
      paths: trashed.map((file) => file.trashed),
      before: { title: row.title, archiveRelPath: row.archiveRelPath },
      undo: { type: DOCUMENT_TRASH_UNDO, data: undoData },
    });
    ctx.events.changed('documents', 'knowledge');
    return { auditId };
  }

  list(): TrashEntry[] {
    return this.deps.audit
      .list({ limit: 1000, onlyUndoable: true })
      .filter((entry) => entry.action === TRASH_ACTION)
      .map((entry) => ({
        auditId: entry.id,
        documentId: entry.entityIds[0] ?? entry.id,
        title: titleOf(entry.before),
        trashedAt: entry.at,
        files: entry.paths.filter((file) => fs.existsSync(file)),
      }));
  }

  /** Deletes everything in the trash for good (second confirmation); the trashed documents can no longer be restored. */
  async empty(request: { confirmed: boolean; permanentlyConfirmed: boolean }): Promise<{ deletedFiles: number; documents: number }> {
    if (!request.confirmed || !request.permanentlyConfirmed)
      throw permissionError('Das Leeren des Papierkorbs löscht endgültig und erfordert eine zweite, ausdrückliche Bestätigung.');
    const { ctx, audit } = this.deps;
    const entries = this.list();
    const deleted: string[] = [];
    for (const entry of entries) {
      for (const file of entry.files) if (await this.deleteInsideTrash(file)) deleted.push(file);
      audit.endUndo(entry.auditId);
    }
    await this.removeEmptyFolders();
    audit.log({
      action: 'trash.empty',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: entries.map((entry) => entry.documentId),
      paths: deleted,
    });
    ctx.events.changed('documents', 'audit');
    return { deletedFiles: deleted.length, documents: entries.length };
  }

  private async trashFiles(row: DocRow): Promise<TrashedFile[]> {
    const trashed: TrashedFile[] = [];
    try {
      for (const file of this.filesOf(row)) {
        const sha256 = await sha256File(file.original);
        const dir = path.join(this.deps.ctx.paths.trash, row.id, file.kind);
        const moved = await this.files.moveExclusive({ source: file.original, dir, name: path.basename(file.original), sha256, naming: 'unique' });
        trashed.push({ ...file, trashed: moved, sha256 });
      }
    } catch (err) {
      await this.putBackAll(trashed.map(trashMove));
      throw err;
    }
    return trashed;
  }

  /** Only files Archivist owns: the archive copy and the own inbox or quarantine copy, never the user's original. */
  private filesOf(row: DocRow): Array<Pick<TrashedFile, 'kind' | 'original'>> {
    const { ctx, documents: access } = this.deps;
    const archived = row.archiveMode === 'index_only' ? null : access.archivePath(row.archiveRelPath);
    const staged = row.stagedPath && [ctx.paths.inbox, ctx.paths.quarantine].some((root) => isInside(root, row.stagedPath!)) ? row.stagedPath : null;
    const files: Array<Pick<TrashedFile, 'kind' | 'original'>> = [];
    if (archived && fs.existsSync(archived)) files.push({ kind: 'archive', original: archived });
    if (staged && fs.existsSync(staged)) files.push({ kind: 'staged', original: staged });
    return files;
  }

  private scanFileIdsOf(documentId: string): string[] {
    const db = this.deps.ctx.database.db;
    return db
      .select({ id: scanFiles.id })
      .from(scanFiles)
      .where(eq(scanFiles.documentId, documentId))
      .all()
      .map((file) => file.id);
  }

  /** Where a trashed file goes back to: the archive file below the archive root valid now (it may have moved meanwhile). */
  private targetOf(file: TrashedFile, row: DocRow): string {
    if (file.kind === 'archive') return this.deps.documents.archivePath(row.archiveRelPath) ?? file.original;
    return file.original;
  }

  private async restoreConflicts(undoData: DocumentTrashUndo): Promise<string[]> {
    if (this.deps.documents.findRow(undoData.row.id)) return ['Das Dokument ist bereits wiederhergestellt.'];
    return undoData.files.flatMap((file) => {
      if (!fs.existsSync(file.trashed)) return [`Die Datei wurde endgültig aus dem Papierkorb gelöscht: ${file.trashed}`];
      const target = this.targetOf(file, undoData.row);
      return fs.existsSync(target) ? [`Am ursprünglichen Ort liegt inzwischen eine andere Datei: ${target}`] : [];
    });
  }

  /** Undo: files back to their place (never overwriting), then the document with its links and search entry. */
  private async restore(undoData: DocumentTrashUndo): Promise<string> {
    const { ctx, graph, documents: access } = this.deps;
    const { row } = undoData;
    const restored: MovedFile[] = [];
    let skipped = 0;
    try {
      for (const file of undoData.files) restored.push(await this.moveBack(file, row));
      ctx.database.transaction(() => {
        ctx.database.db.insert(documents).values(row).run();
        if (undoData.scanFileIds.length) ctx.database.db.update(scanFiles).set({ documentId: row.id }).where(inArray(scanFiles.id, undoData.scanFileIds)).run();
        if (undoData.node) skipped = graph.restoreNode(undoData.node);
      });
    } catch (err) {
      await this.putBackAll(restored);
      throw err;
    }
    await pruneEmptyDirs(ctx.paths.trash, path.join(ctx.paths.trash, row.id, 'archive'));
    await pruneEmptyDirs(ctx.paths.trash, path.join(ctx.paths.trash, row.id, 'staged'));
    await access.indexDocument(row.id);
    ctx.events.changed('documents', 'knowledge');
    const lost = skipped > 0 ? ` Nicht wiederhergestellt, weil inzwischen entfernt: ${skipped === 1 ? 'eine Verknüpfung' : `${skipped} Verknüpfungen`}.` : '';
    return `„${row.title}“ aus dem Papierkorb wiederhergestellt.${lost}`;
  }

  private async moveBack(file: TrashedFile, row: DocRow): Promise<MovedFile> {
    const target = this.targetOf(file, row);
    const moved = await this.files.moveExclusive({
      source: file.trashed,
      dir: path.dirname(target),
      name: path.basename(target),
      sha256: file.sha256,
      naming: 'exact',
    });
    return { moved, original: file.trashed, sha256: file.sha256 };
  }

  /** Takes moved files back after a failed step; whatever cannot go back is logged with its place. */
  private async putBackAll(files: MovedFile[]): Promise<void> {
    for (const file of files.toReversed()) {
      const note = await this.files.putBack(file);
      if (note) this.deps.ctx.logger.error('documents', 'Trash move not fully taken back', { note });
    }
  }

  /** Deletes `file` only when its real path lies strictly inside the trash. */
  private async deleteInsideTrash(file: string): Promise<boolean> {
    const trash = this.deps.ctx.paths.trash;
    let real: string;
    try {
      real = await fsp.realpath(file);
    } catch {
      return false;
    }
    const realTrash = await fsp.realpath(trash).catch(() => trash);
    if (!isInside(realTrash, real) || path.resolve(realTrash) === path.resolve(real))
      throw new AppError('permission_error', `Liegt nicht im Papierkorb: ${file}`);
    await fsp.rm(real, { force: true });
    return true;
  }

  private async removeEmptyFolders(): Promise<void> {
    const trash = this.deps.ctx.paths.trash;
    for (const entry of await fsp.readdir(trash, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['archive', 'staged']) await pruneEmptyDirs(trash, path.join(trash, entry.name, kind));
    }
  }
}
