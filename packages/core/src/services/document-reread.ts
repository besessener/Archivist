import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { documents } from '../db/schema';
import { fsError } from '../util/errors';
import { nowIso } from '../util/ids';
import { ARCHIVED_STATUSES, extractFile, extractedColumns, isArchivedStatus, type DocumentDeps } from './document-model';

/** Reads the text of archived and index-only documents again, keeping their metadata, assignments and links. */
export class DocumentRereader {
  constructor(private readonly deps: DocumentDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /**
   * A changed original of an index-only document must not stay searchable with its old content (#229): re-reads it
   * locally and re-indexes it; a stale inbox copy is removed. False if nothing changed or the document is not index-only.
   */
  async refreshIndexedOnly(id: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    const row = this.deps.documents.findRow(id);
    if (!row || row.status !== 'indexed_only' || !row.sourcePath) return false;
    const source = row.sourcePath;
    const sha = await this.deps.pool.run('hashFile', { path: source });
    if (sha === row.sha256) return false;
    opts.signal?.throwIfAborted();
    const [stat, parsed] = await Promise.all([fsp.stat(source), extractFile(this.deps, source)]);
    opts.signal?.throwIfAborted();
    const updated = this.db
      .update(documents)
      .set({ sha256: sha, size: stat.size, ...extractedColumns(parsed), stagedPath: null, updatedAt: nowIso() })
      .where(and(eq(documents.id, id), eq(documents.status, 'indexed_only'), eq(documents.sha256, row.sha256)))
      .run();
    if (!updated.changes) return false;
    if (row.stagedPath) await fsp.rm(row.stagedPath, { force: true }).catch(() => undefined);
    this.deps.audit.log({
      action: 'document.refresh',
      actor: 'agent',
      trigger: 'source_changed',
      confirmed: true,
      entityIds: [id],
      paths: [source],
      before: { sha256: row.sha256, size: row.size },
      after: { sha256: sha, size: stat.size },
    });
    await this.deps.documents.indexDocument(id);
    this.deps.ctx.events.changed('documents', 'knowledge');
    return true;
  }

  /** Extraction and OCR run again on the archive file (index-only: the original) and the index is rebuilt (#220, #305). */
  async rereadArchived(id: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    const row = this.deps.documents.findRow(id);
    if (!row || !isArchivedStatus(row.status)) return false;
    const file = row.status === 'indexed_only' ? row.sourcePath : this.deps.documents.archivePath(row.archiveRelPath);
    if (!file || !fs.existsSync(file)) throw fsError('Die Datei des Dokuments ist nicht mehr vorhanden.', undefined, false);
    const parsed = await extractFile(this.deps, file);
    opts.signal?.throwIfAborted();
    const updated = this.db
      .update(documents)
      .set({ ...extractedColumns(parsed), updatedAt: nowIso() })
      .where(and(eq(documents.id, id), inArray(documents.status, ARCHIVED_STATUSES)))
      .run();
    if (!updated.changes) return false;
    this.deps.audit.log({
      action: 'document.reread',
      actor: 'user',
      trigger: 'reread',
      confirmed: true,
      entityIds: [id],
      paths: [file],
      before: { chars: row.extractedText.length, processingStatus: row.processingStatus },
      after: { chars: parsed.text.length, processingStatus: parsed.status },
    });
    await this.deps.documents.indexDocument(id);
    this.deps.ctx.events.changed('documents', 'knowledge');
    return true;
  }
}
