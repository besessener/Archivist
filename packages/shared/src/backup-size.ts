/** From this size on, the space the backups can take is worth a warning. */
export const BACKUP_SIZE_WARNING_BYTES = 2 * 1024 ** 3;

export interface BackupSizeInput {
  databaseBytes: number;
  /** Everything in the backups folder as it is now. */
  backupsBytes: number;
  /** Backups kept per kind (`backups.keep`). */
  keep: number;
}

/** A metadata backup is a copy of the whole database, so `keep` of them can take `keep` times its size. */
export function assessBackupSize({ databaseBytes, backupsBytes, keep }: BackupSizeInput): { metadataWorstCaseBytes: number; large: boolean } {
  const metadataWorstCaseBytes = databaseBytes * Math.max(1, keep);
  return { metadataWorstCaseBytes, large: Math.max(metadataWorstCaseBytes, backupsBytes) >= BACKUP_SIZE_WARNING_BYTES };
}
