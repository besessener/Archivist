import { AppError } from '../util/errors';
import { outcomeWithoutChange, type ArchiveOutcome } from './archive-model';

const ROOT_CHANGE_RUNNING = 'Der Archivordner wird gerade umgestellt. Bitte warte, bis das abgeschlossen ist.';
const BACKUP_RUNNING = 'Gerade läuft ein vollständiges Backup. Bitte versuche es gleich noch einmal.';
const OPERATIONS_RUNNING = 'Gerade werden Dokumente archiviert oder umgelagert. Bitte versuche es gleich noch einmal.';
export const DOCUMENT_BUSY = 'Dieses Dokument wird gerade schon archiviert oder verschoben.';

/** A release function that only acts on its first call. */
function releaseOnce(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/** Keeps archive file operations, archive root changes and full backups from running into each other. */
export class ArchiveLocks {
  /** Archive file operations (archive, relocate, rename) currently running. */
  private inFlight = 0;
  /** Documents a file operation is working on right now; a second one for the same document reports a conflict (#240). */
  private readonly busy = new Set<string>();
  private rootChangeActive = false;
  private backupActive = false;

  /** Blocks archive file operations while the archive root is changed; returns the function that lifts the block. */
  beginRootChange(): () => void {
    if (this.rootChangeActive) throw new AppError('archive_conflict', ROOT_CHANGE_RUNNING);
    if (this.backupActive) throw new AppError('archive_conflict', BACKUP_RUNNING, { retryable: true });
    if (this.inFlight > 0) throw new AppError('archive_conflict', OPERATIONS_RUNNING, { retryable: true });
    this.rootChangeActive = true;
    return releaseOnce(() => {
      this.rootChangeActive = false;
    });
  }

  /** Blocks archive file operations while a full backup copies the archive, so database snapshot and files match. */
  beginBackup(): () => void {
    if (this.rootChangeActive) throw new AppError('archive_conflict', ROOT_CHANGE_RUNNING, { retryable: true });
    if (this.backupActive) throw new AppError('archive_conflict', 'Es läuft bereits ein vollständiges Backup.', { retryable: true });
    if (this.inFlight > 0) throw new AppError('archive_conflict', OPERATIONS_RUNNING, { retryable: true });
    this.backupActive = true;
    return releaseOnce(() => {
      this.backupActive = false;
    });
  }

  isRootChangeActive(): boolean {
    return this.rootChangeActive;
  }

  /** Runs an archive file operation unless the archive root is being changed or backed up right now. */
  async guarded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.rootChangeActive) throw new AppError('archive_conflict', ROOT_CHANGE_RUNNING, { retryable: true });
    if (this.backupActive) throw new AppError('archive_conflict', BACKUP_RUNNING, { retryable: true });
    this.inFlight += 1;
    try {
      return await operation();
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Runs one file operation for a document unless another one is already working on it. */
  async onePerDocument(documentId: string, operation: () => Promise<ArchiveOutcome>): Promise<ArchiveOutcome> {
    if (this.busy.has(documentId)) return outcomeWithoutChange({ documentId, outcome: 'conflict', message: DOCUMENT_BUSY });
    this.busy.add(documentId);
    try {
      return await operation();
    } finally {
      this.busy.delete(documentId);
    }
  }
}
