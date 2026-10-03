import type { ScanFile, ScanFileStatus, ScanRoot } from '@archivist/shared';
import type { scanFiles, scanRoots } from '../../db/schema';
import type { DocumentService } from '../documents';

export type RootRow = typeof scanRoots.$inferSelect;
export type FileRow = typeof scanFiles.$inferSelect;

/** Scan file states of files nobody has processed yet (their duplicate state is re-evaluated on every scan). */
export const PENDING_FILE_STATUSES: ScanFileStatus[] = ['new', 'changed', 'known', 'duplicate'];

export const mapRoot = (row: RootRow): ScanRoot => ({
  id: row.id,
  path: row.path,
  enabled: row.enabled,
  recursive: row.recursive,
  excludedSubdirs: row.excludedSubdirs,
  extensions: row.extensions,
  maxFileSizeMb: row.maxFileSizeMb,
  llmAllowed: row.llmAllowed,
  lastScanAt: row.lastScanAt,
  createdAt: row.createdAt,
});

export const mapFile = (row: FileRow): ScanFile => ({
  id: row.id,
  rootId: row.rootId,
  path: row.path,
  name: row.name,
  ext: row.ext,
  size: row.size,
  mtimeMs: row.mtimeMs,
  sha256: row.sha256,
  mime: row.mime,
  status: row.status as ScanFileStatus,
  llmStatus: row.llmStatus as ScanFile['llmStatus'],
  documentId: row.documentId,
  duplicateOfDocumentId: row.duplicateOfDocumentId,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

/** Active document (inbox or archive) with this content other than the file's own one – the upload's rule, so nothing comes in twice. */
export function duplicateOf(docs: DocumentService, content: { sha256: string; documentId?: string | null }): string | null {
  return docs.findDuplicates(content.sha256, content.documentId ?? undefined)[0]?.id ?? null;
}
