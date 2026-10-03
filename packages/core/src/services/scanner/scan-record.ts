import path from 'node:path';
import type { ScanFileStatus, ScanSummary } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { scanFiles } from '../../db/schema';
import { MIME_BY_EXT } from '../../parsers';
import { newId } from '../../util/ids';
import type { ScanEntry } from '../../workers/tasks';
import type { DocumentService } from '../documents';
import type { NotificationService } from '../notifications';
import type { PrivacyService } from '../privacy';
import { duplicateOf, PENDING_FILE_STATUSES, type FileRow, type RootRow } from './scan-files';

export interface ScanRecorderDeps {
  ctx: AppContext;
  docs: DocumentService;
  privacy: PrivacyService;
  notifications: NotificationService;
}

/** One walked file of a scan root, with what the scan knew about it before. */
export interface EntryScope {
  root: RootRow;
  entry: ScanEntry;
  previous: FileRow | undefined;
  summary: ScanSummary;
  now: string;
}

/** What the asynchronous part of a scan step found out about a file before its row is written. */
export interface EntryOutcome {
  sha?: string;
  error?: string;
  /** The original of an index-only document was re-read in place. */
  refreshed?: boolean;
}

const sizeAndTimeUnchanged = (previous: FileRow, entry: ScanEntry): boolean => previous.size === entry.size && previous.mtimeMs === entry.mtimeMs;

/** Known, unchanged (size and mtime) and excluded files are neither hashed nor analyzed again. */
export const needsHash = (previous: FileRow | undefined, entry: ScanEntry): boolean => previous?.status !== 'excluded' && !(previous && sizeAndTimeUnchanged(previous, entry));

export const scanResultsAction = () => ({ label: 'Scan-Ergebnisse prüfen', kind: 'navigate' as const, target: '/scan/' });

/** Writes the rows of walked files: unchanged files are only refreshed, new or changed ones are checked for duplicates. */
export class ScanRecorder {
  constructor(private readonly deps: ScanRecorderDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** The original of an index-only document changed: re-read it in place, the scan file keeps its status (#229). */
  async refreshIndexedOnly(previous: FileRow): Promise<boolean> {
    const doc = previous.documentId ? this.deps.docs.findRow(previous.documentId) : undefined;
    if (doc?.status !== 'indexed_only') return false;
    try {
      await this.deps.docs.refreshIndexedOnly(doc.id);
      return true;
    } catch (err) {
      this.deps.ctx.logger.warn('scanner', 'Index-only document not refreshed', { documentId: doc.id, error: err });
      return false;
    }
  }

  /** Synchronous part of one scan step; the caller runs a whole batch of these in one transaction. */
  apply(scope: EntryScope, outcome: EntryOutcome): void {
    const { entry, previous, summary, now } = scope;
    if (previous?.status === 'excluded') {
      summary.excluded += 1;
      return;
    }
    if (previous && sizeAndTimeUnchanged(previous, entry)) {
      this.markUnchanged({ previous, summary }, { lastSeenAt: now });
      return;
    }
    if (outcome.error !== undefined || outcome.sha === undefined) {
      summary.errors.push(`${entry.path}: ${outcome.error ?? 'Datei nicht lesbar'}`);
      return;
    }
    if (previous && previous.sha256 === outcome.sha) {
      // only the timestamp changed (touched, or restored by an undo): same content, the status stays
      this.markUnchanged({ previous, summary }, { size: entry.size, mtimeMs: entry.mtimeMs, lastSeenAt: now });
      return;
    }
    if (previous && outcome.refreshed) {
      this.db.update(scanFiles).set({ size: entry.size, mtimeMs: entry.mtimeMs, sha256: outcome.sha, lastSeenAt: now }).where(eq(scanFiles.id, previous.id)).run();
      summary.changedFiles += 1;
      return;
    }
    this.recordContent({ ...scope, sha: outcome.sha });
  }

  /** Re-evaluates the duplicate state of a not yet processed file whose content did not change. */
  private recheckDuplicate(previous: FileRow): Pick<FileRow, 'status' | 'duplicateOfDocumentId'> | null {
    if (!previous.sha256 || !PENDING_FILE_STATUSES.includes(previous.status as ScanFileStatus)) return null;
    const duplicate = duplicateOf(this.deps.docs, { sha256: previous.sha256, documentId: previous.documentId });
    if (duplicate)
      return duplicate === previous.duplicateOfDocumentId && previous.status === 'duplicate' ? null : { status: 'duplicate', duplicateOfDocumentId: duplicate };
    // the document it duplicated is gone (ignored, deleted): the file is open again
    return previous.status === 'duplicate' ? { status: 'new', duplicateOfDocumentId: null } : null;
  }

  /** Content of a known file is unchanged: refresh it (and its duplicate state) without touching its status otherwise. */
  private markUnchanged(file: { previous: FileRow; summary: ScanSummary }, set: Partial<FileRow>): void {
    const duplicate = this.recheckDuplicate(file.previous);
    this.db
      .update(scanFiles)
      .set({ ...set, ...duplicate })
      .where(eq(scanFiles.id, file.previous.id))
      .run();
    if (duplicate?.status === 'duplicate') file.summary.duplicates += 1;
    file.summary.unchanged += 1;
  }

  /** New or changed content: privacy status and duplicate state are evaluated afresh. */
  private recordContent(scope: EntryScope & { sha: string }): void {
    const { root, entry, previous, summary } = scope;
    const decision = this.deps.privacy.evaluate({ path: entry.path, ext: entry.ext, rootLlmAllowed: root.llmAllowed });
    const llmStatus = decision.allowed ? 'local_only' : (decision.status ?? 'local_only');
    const duplicate = duplicateOf(this.deps.docs, { sha256: scope.sha, documentId: previous?.documentId });
    if (previous) this.recordChanged({ ...scope, previous }, { llmStatus, duplicate });
    else this.recordNew(scope, { llmStatus, duplicate });
    if (duplicate) summary.duplicates += 1;
  }

  private recordChanged(scope: EntryScope & { sha: string; previous: FileRow }, state: { llmStatus: string; duplicate: string | null }): void {
    const { entry, previous, sha, now } = scope;
    const wasArchived = previous.status === 'archived' || previous.status === 'analyzed';
    const status: ScanFileStatus = state.duplicate ? 'duplicate' : 'changed';
    this.db
      .update(scanFiles)
      .set({
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: sha,
        status,
        llmStatus: state.llmStatus,
        duplicateOfDocumentId: state.duplicate,
        lastSeenAt: now,
      })
      .where(eq(scanFiles.id, previous.id))
      .run();
    scope.summary.changedFiles += 1;
    if (!wasArchived) return;
    this.deps.notifications.create({
      title: 'Datei seit Archivierung verändert',
      description: `„${entry.name}“ in ${path.dirname(entry.path)} wurde nach der Archivierung geändert.`,
      type: 'file_changed',
      priority: 'normal',
      affectedEntityIds: previous.documentId ? [previous.documentId] : [],
      proposedActions: [scanResultsAction()],
      dedupeKey: `file-changed:${previous.id}:${sha}`,
    });
  }

  private recordNew(scope: EntryScope & { sha: string }, state: { llmStatus: string; duplicate: string | null }): void {
    const { root, entry, sha, now } = scope;
    this.db
      .insert(scanFiles)
      .values({
        id: newId(),
        rootId: root.id,
        path: entry.path,
        name: entry.name,
        ext: entry.ext,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: sha,
        mime: MIME_BY_EXT[entry.ext] ?? entry.mime,
        status: state.duplicate ? 'duplicate' : 'new',
        llmStatus: state.llmStatus,
        documentId: null,
        duplicateOfDocumentId: state.duplicate,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    scope.summary.newFiles += 1;
  }
}
