import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { documents } from '../db/schema';
import { fsError } from '../util/errors';
import { sha256File } from '../util/hash';
import { nowIso } from '../util/ids';
import { hasChecksum, pruneEmptyDirs } from './archive-files';
import { archivePathOf, archiveRootOf, type ArchiveUndoData } from './archive-model';
import type { ArchiveDeps } from './archive-deps';

const hasArchiveFile = (d: ArchiveUndoData) => d.mode === 'copy' || d.mode === 'move';

/** True when, after undo, a file with the archived checksum still exists outside the archive (restored or untouched). */
async function otherCopyRemains(d: ArchiveUndoData): Promise<boolean> {
  if (d.removedStaged || d.removedSource) return true;
  for (const p of [d.sourcePath, d.stagedPath]) if (p && (await hasChecksum(p, d.sha256))) return true;
  return false;
}

/** Location the archived version returns to when it is the only copy left. */
const putBackOrigin = (d: ArchiveUndoData): string | null => d.sourcePath ?? d.stagedPath;

/** Fails when the restored file does not match; never leaves an unverified file behind. */
async function verifyRestored(dest: string, sha256: string): Promise<void> {
  if ((await sha256File(dest)) !== sha256) {
    await fsp.unlink(dest).catch(() => undefined);
    throw fsError('Wiederherstellung konnte nicht verifiziert werden.');
  }
}

function undoneMessage(d: ArchiveUndoData, putBackPath: string | null): string {
  if (putBackPath && path.basename(putBackPath) !== path.basename(putBackOrigin(d)!))
    return `Archivierung rückgängig gemacht. Am ursprünglichen Ort liegt inzwischen eine andere Fassung; sie bleibt unberührt, und die archivierte Fassung liegt jetzt als „${path.basename(putBackPath)}“ daneben. Es wurde nichts gelöscht.`;
  if (d.mode === 'ignore') return 'Ignorieren rückgängig gemacht.';
  if (d.mode === 'index_only') return 'Indexierung rückgängig gemacht.';
  return 'Archivierung rückgängig gemacht; die Datei liegt wieder am ursprünglichen Ort.';
}

/** Undo of archiving, indexing or ignoring; never deletes the only copy of a file. */
export class ArchiveUndo {
  constructor(private readonly deps: ArchiveDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async check(d: ArchiveUndoData): Promise<string[]> {
    if (this.deps.locks.isRootChangeActive()) return ['Der Archivordner wird gerade umgestellt.'];
    const row = this.db.select().from(documents).where(eq(documents.id, d.documentId)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    const conflicts: string[] = [];
    if (row.updatedAt !== d.afterUpdatedAt) conflicts.push('Das Dokument wurde seit der Archivierung verändert.');
    conflicts.push(...this.deps.graph.relationChangeConflicts(d.relations));
    if (hasArchiveFile(d)) conflicts.push(...(await this.fileConflicts(d)));
    return conflicts;
  }

  private async fileConflicts(d: ArchiveUndoData): Promise<string[]> {
    const conflicts: string[] = [];
    const abs = d.archiveRel ? archivePathOf(archiveRootOf(this.deps), d.archiveRel) : null;
    if (!abs || !fs.existsSync(abs)) conflicts.push('Die archivierte Datei fehlt am erwarteten Ort.');
    else if ((await sha256File(abs)) !== d.sha256) conflicts.push('Die archivierte Datei wurde seit der Archivierung verändert.');
    if (d.removedStaged && d.stagedPath && fs.existsSync(d.stagedPath)) conflicts.push(`Am Eingangsort existiert bereits eine Datei: ${d.stagedPath}`);
    if (d.removedSource && d.sourcePath) conflicts.push(...sourceConflicts(d.sourcePath));
    if (!(await otherCopyRemains(d))) conflicts.push(...originConflicts(d));
    return conflicts;
  }

  async run(d: ArchiveUndoData): Promise<string> {
    const root = archiveRootOf(this.deps);
    const abs = d.archiveRel ? archivePathOf(root, d.archiveRel) : null;
    const putBackPath = hasArchiveFile(d) && abs ? await this.restoreFiles(d, abs) : null;
    this.deps.ctx.database.transaction(() => {
      this.db
        .update(documents)
        .set({
          ...d.before,
          stagedPath: d.removedStaged ? d.stagedPath : d.before.stagedPath,
          // the document now refers to the file that actually holds its content
          ...(putBackPath ? (d.sourcePath ? { sourcePath: putBackPath } : { stagedPath: putBackPath }) : {}),
          updatedAt: nowIso(),
        })
        .where(eq(documents.id, d.documentId))
        .run();
      if (d.relations) this.deps.graph.revertRelationChanges(d.relations);
      // undo data written before relation tracking existed only lists the linked relations
      else for (const relationId of d.relationIds ?? []) this.deps.graph.deleteRelation(relationId);
    });
    await this.deps.docs.indexDocument(d.documentId);
    this.deps.ctx.events.emit('document:unarchived', { documentId: d.documentId });
    this.deps.ctx.events.changed('documents', 'knowledge', 'status');
    return undoneMessage(d, putBackPath);
  }

  /** Restores removed copies (or puts the only copy back to its origin), then removes the archive file; returns the put-back path. */
  private async restoreFiles(d: ArchiveUndoData, abs: string): Promise<string | null> {
    const restoreTo = async (dest: string) => {
      await fsp.copyFile(abs, dest, fs.constants.COPYFILE_EXCL);
      await verifyRestored(dest, d.sha256);
    };
    const origin = (await otherCopyRemains(d)) ? null : putBackOrigin(d);
    if (d.removedStaged && d.stagedPath) await restoreTo(d.stagedPath);
    if (d.removedSource && d.sourcePath) await restoreTo(d.sourcePath);
    let putBackPath: string | null = null;
    if (origin) {
      // Never overwrite whatever is at the origin now (e.g. the edited original): a taken name becomes "Name (2).ext".
      putBackPath = await this.deps.files.copyExclusive({ source: abs, dir: path.dirname(origin), fileName: path.basename(origin) });
      await verifyRestored(putBackPath, d.sha256);
    }
    await fsp.unlink(abs);
    await pruneEmptyDirs(archiveRootOf(this.deps), path.dirname(abs));
    return putBackPath;
  }
}

function sourceConflicts(sourcePath: string): string[] {
  if (fs.existsSync(sourcePath)) return [`Am ursprünglichen Ort existiert bereits eine Datei: ${sourcePath}`];
  if (!fs.existsSync(path.dirname(sourcePath))) return [`Der ursprüngliche Ordner existiert nicht mehr: ${path.dirname(sourcePath)}`];
  return [];
}

/** The archived version is the only copy left: undo puts it back to its origin instead of deleting it. */
function originConflicts(d: ArchiveUndoData): string[] {
  const origin = putBackOrigin(d);
  if (!origin) return ['Es gibt keine weitere Kopie der Datei und keinen ursprünglichen Ort – Undo würde die einzige Kopie löschen.'];
  if (!fs.existsSync(path.dirname(origin))) return [`Der ursprüngliche Ordner existiert nicht mehr: ${path.dirname(origin)}`];
  return [];
}
