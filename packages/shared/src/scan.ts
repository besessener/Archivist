import { z } from 'zod';
import { Id, IsoDate } from './common';
import { LlmStatus } from './documents';

export const ScanRoot = z.object({
  id: Id,
  path: z.string(),
  enabled: z.boolean(),
  recursive: z.boolean(),
  excludedSubdirs: z.array(z.string()),
  extensions: z.array(z.string()),
  maxFileSizeMb: z.number(),
  llmAllowed: z.boolean(),
  lastScanAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type ScanRoot = z.infer<typeof ScanRoot>;

export const ScanFileStatus = z.enum(['new', 'changed', 'known', 'analyzed', 'archived', 'duplicate', 'excluded']);
export type ScanFileStatus = z.infer<typeof ScanFileStatus>;
export const ScanFile = z.object({
  id: Id,
  rootId: Id,
  path: z.string(),
  name: z.string(),
  ext: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  sha256: z.string().nullable(),
  mime: z.string(),
  status: ScanFileStatus,
  llmStatus: LlmStatus,
  documentId: z.string().nullable(),
  duplicateOfDocumentId: z.string().nullable(),
  firstSeenAt: IsoDate,
  lastSeenAt: IsoDate,
});
export type ScanFile = z.infer<typeof ScanFile>;

export const ScanSummary = z.object({
  rootId: Id,
  scanned: z.number(),
  newFiles: z.number(),
  changedFiles: z.number(),
  unchanged: z.number(),
  excluded: z.number(),
  skipped: z.number(),
  duplicates: z.number(),
  errors: z.array(z.string()),
});
export type ScanSummary = z.infer<typeof ScanSummary>;

export const ScanProposalGroup = z.object({
  key: z.string(),
  label: z.string(),
  topic: z.string().nullable(),
  project: z.string().nullable(),
  documentIds: z.array(z.string()),
  confidence: z.number(),
});
export type ScanProposalGroup = z.infer<typeof ScanProposalGroup>;

export const ScanExclusion = z.object({ id: Id, kind: z.enum(['file', 'dir']), path: z.string(), createdAt: IsoDate });
export type ScanExclusion = z.infer<typeof ScanExclusion>;
