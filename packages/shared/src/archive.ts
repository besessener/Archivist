import { z } from 'zod';
import { EntityRef, Id, IsoDate } from './common';
import { ArchiveMode } from './documents';

export const ArchivePlanItem = z.object({
  documentId: Id,
  title: z.string(),
  action: ArchiveMode,
  sourcePath: z.string().nullable(),
  targetPath: z.string().nullable(),
  targetRelPath: z.string().nullable(),
  renamed: z.boolean(),
  /** True only when a file outside Archivist (the user's original) gets deleted, i.e. on move. */
  willRemoveSource: z.boolean(),
  /** True when Archivist's own temporary inbox copy gets cleaned up afterwards (the original is untouched). */
  removesInboxCopy: z.boolean(),
  duplicates: z.array(z.object({ documentId: Id, title: z.string(), archivePath: z.string().nullable() })),
  conflicts: z.array(z.string()),
  newCategories: z.array(z.string()),
  affected: z.array(EntityRef),
  rationale: z.string(),
  confidence: z.number().nullable(),
  blocked: z.boolean(),
});
export type ArchivePlanItem = z.infer<typeof ArchivePlanItem>;
export const ArchivePlan = z.object({
  items: z.array(ArchivePlanItem),
  newCategories: z.array(z.string()),
  requiresStrongConfirmation: z.boolean(),
  summary: z.string(),
});
export type ArchivePlan = z.infer<typeof ArchivePlan>;

export const ArchiveItemRequest = z.object({
  documentId: Id,
  mode: ArchiveMode.default('copy'),
  categoryPath: z.string().optional(),
  fileName: z.string().optional(),
  /** Omitted: use the proposal. `null` (or an empty string): explicitly without topic. */
  topic: z.string().nullish(),
  /** Omitted: use the proposal. `null` (or an empty string): explicitly without project. */
  project: z.string().nullish(),
});
export type ArchiveItemRequest = z.infer<typeof ArchiveItemRequest>;

export const ArchiveResultItem = z.object({
  documentId: Id,
  outcome: z.enum(['success', 'skipped', 'failed', 'conflict']),
  targetPath: z.string().nullable(),
  message: z.string(),
  auditId: z.string().nullable(),
});
export const ArchiveResult = z.object({
  items: z.array(ArchiveResultItem),
  success: z.number(),
  skipped: z.number(),
  failed: z.number(),
  conflicts: z.number(),
});
export type ArchiveResult = z.infer<typeof ArchiveResult>;

export const Category = z.object({ id: Id, path: z.string(), approved: z.boolean(), createdAt: IsoDate });
export type Category = z.infer<typeof Category>;

export const BackupInfo = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['metadata', 'full']),
  createdAt: IsoDate,
  sizeBytes: z.number(),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

export const VerifyReport = z.object({
  checkedDocuments: z.number(),
  missingFiles: z.array(z.object({ documentId: Id, title: z.string(), path: z.string() })),
  changedFiles: z.array(z.object({ documentId: Id, title: z.string(), path: z.string() })),
  untrackedFiles: z.array(z.string()),
  ok: z.boolean(),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

/** `migrate`: copy the archive to the new folder, verify and switch; `pathOnly`: only switch (the files are already there). */
export const ArchiveRootChangeMode = z.enum(['migrate', 'pathOnly']);
export type ArchiveRootChangeMode = z.infer<typeof ArchiveRootChangeMode>;

/** Where the archived documents would be found under a (new) archive root. */
export const ArchiveRootPresence = z.object({
  /** Archived documents (status `archived` with an archive path). */
  documents: z.number(),
  /** Found at the same relative path with the expected size. */
  present: z.number(),
  /** No file at the expected path. */
  missing: z.number(),
  /** A file exists there but its size differs from the archived one. */
  different: z.number(),
  /** Titles of some missing or different documents (at most 5). */
  examples: z.array(z.string()),
});
export type ArchiveRootPresence = z.infer<typeof ArchiveRootPresence>;

export const ArchiveRootPreview = z.object({
  from: z.string(),
  to: z.string(),
  /** Presence of the archived documents in the new folder as it is now. */
  atTarget: ArchiveRootPresence,
  migrate: z.object({
    /** Files in the current archive folder that the move copies (or finds already present). */
    files: z.number(),
    bytes: z.number(),
    /** Files that already exist in the new folder with the same size (verified by checksum during the move). */
    alreadyPresent: z.number(),
    /** Reasons why moving the archive is not possible (empty = possible). */
    blockers: z.array(z.string()),
  }),
  /** Reasons why only changing the path is not possible (empty = possible). */
  pathOnlyBlockers: z.array(z.string()),
});
export type ArchiveRootPreview = z.infer<typeof ArchiveRootPreview>;

export const ArchiveRootStatus = z.object({
  root: z.string(),
  /** Presence of the archived documents under the current archive root. */
  current: ArchiveRootPresence,
  /** Most recent archive root change (if any). */
  lastChange: z
    .object({
      auditId: Id,
      at: IsoDate,
      from: z.string(),
      to: z.string(),
      mode: ArchiveRootChangeMode,
      undoable: z.boolean(),
    })
    .nullable(),
});
export type ArchiveRootStatus = z.infer<typeof ArchiveRootStatus>;

export const ArchiveRootChangeResult = z.object({
  mode: ArchiveRootChangeMode,
  /** Background job of a move (`migrate`), null for `pathOnly`. */
  jobId: Id.nullable(),
  /** Audit entry of a `pathOnly` change (undoable), null while a move is still running. */
  auditId: Id.nullable(),
  /** Archived documents that are not reachable under the new path (`pathOnly` only). */
  unreachable: z.number(),
});
export type ArchiveRootChangeResult = z.infer<typeof ArchiveRootChangeResult>;
