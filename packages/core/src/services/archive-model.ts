import path from 'node:path';
import type { ArchiveResult } from '@archivist/shared';
import type { relations } from '../db/schema';
import { toErrorInfo } from '../util/errors';
import type { DocRow } from './documents';
import type { RelationChangeSet } from './knowledge-graph';

export type ArchiveOutcome = ArchiveResult['items'][number];
export type RelationRow = typeof relations.$inferSelect;

export interface ArchiveUndoData {
  documentId: string;
  mode: 'copy' | 'move' | 'index_only' | 'ignore';
  archiveRel: string | null;
  sha256: string;
  sourcePath: string | null;
  stagedPath: string | null;
  removedStaged: boolean;
  removedSource: boolean;
  before: Pick<DocRow, 'status' | 'archiveRelPath' | 'categoryPath' | 'topicId' | 'projectId' | 'archiveMode' | 'stagedPath' | 'archivedAt' | 'persons'>;
  /** Relation changes of the archiving (absent in undo data written by older versions). */
  relations?: RelationChangeSet;
  /** Older undo data: ids of all relations the archiving linked, including ones that existed before. */
  relationIds?: string[];
  afterUpdatedAt: string;
}

export interface RelocateUndoData {
  documentId: string;
  fromRel: string;
  toRel: string;
  sha256: string;
  beforeCategoryPath: string | null;
  /** updatedAt before relocating; undo restores it so that the archiving itself stays undoable. Missing in old entries. */
  beforeUpdatedAt?: string;
  afterUpdatedAt: string;
  /** Relation to the new category, if relocating created it (removed again on undo). */
  addedRelationId: string | null;
  /** Legacy entries only: category whose relation was deleted; undo re-links it as confirmed. */
  removedCategory?: string | null;
  /** Category relations deleted by relocating, exactly as they were (undo inserts them again with the same id). */
  relationsRemoved?: RelationRow[];
  /** Category relations whose status relocating changed to confirmed, exactly as they were before. */
  relationsChanged?: RelationRow[];
}

export interface RenameUndoData {
  documentId: string;
  fromRel: string;
  toRel: string;
  sha256: string;
  beforeTitle: string;
  beforeUpdatedAt: string;
  afterUpdatedAt: string;
}

/** Request: rename the file of an archived document within its folder (#304). */
export interface RenameRequest {
  documentId: string;
  /** New file name; the extension is kept (added when missing). */
  fileName: string;
}

export interface RenamePlanItem {
  documentId: string;
  from: string | null;
  to: string | null;
  unchanged: boolean;
  conflicts: string[];
}

/** Request: move an already archived document into another archive folder. */
export interface RelocateRequest {
  documentId: string;
  categoryPath: string;
  /** Main category the caller has already had confirmed by the user, so a preview does not block on it. */
  confirmedMainCategory?: string;
}

export interface RelocatePlanItem {
  documentId: string;
  title: string;
  fromRelPath: string | null;
  toRelPath: string | null;
  /** Target folder (relative to the archive) as it reads after sanitizing. */
  categoryPath: string | null;
  renamed: boolean;
  /** already lies in the target folder */
  unchanged: boolean;
  blocked: boolean;
  conflicts: string[];
}

export interface ExecuteOptions {
  confirmed: boolean;
  approveNewCategories: string[];
  confirmMove: boolean;
  trigger?: string;
}

export const archiveRootOf = (deps: { settings: { get(): { archiveRoot: string } } }): string => deps.settings.get().archiveRoot;

export const toPosix = (p: string): string => p.split(path.sep).join('/');

export const archivePathOf = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

export const emptyArchiveResult = (): ArchiveResult => ({ items: [], success: 0, skipped: 0, failed: 0, conflicts: 0 });

/** Adds an item to the result and counts it by its outcome. */
export function addOutcome(result: ArchiveResult, outcome: ArchiveOutcome): void {
  result.items.push(outcome);
  if (outcome.outcome === 'success') result.success += 1;
  else if (outcome.outcome === 'skipped') result.skipped += 1;
  else if (outcome.outcome === 'conflict') result.conflicts += 1;
  else result.failed += 1;
}

/** User-facing message of an error, with its details in parentheses. */
export function failureMessage(err: unknown): string {
  const info = toErrorInfo(err);
  return info.message + (info.details ? ` (${info.details})` : '');
}

/** Outcome of an item that changed no file and wrote no audit entry. */
export const outcomeWithoutChange = (item: Pick<ArchiveOutcome, 'documentId' | 'outcome' | 'message'>): ArchiveOutcome => ({
  documentId: item.documentId,
  outcome: item.outcome,
  targetPath: null,
  message: item.message,
  auditId: null,
});
