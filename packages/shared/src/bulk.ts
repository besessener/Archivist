import { z } from 'zod';
import { Id, IsoDate } from './common';

/** What a bulk run would send: files or documents, how many of them may go to the LLM, and a rough token estimate. */
export const BulkEstimate = z.object({
  total: z.number().int().min(0),
  llmEligible: z.number().int().min(0).describe('davon dürfen laut Einstellungen an das LLM gesendet werden'),
  estimatedTokens: z.number().int().min(0).describe('grobe Schätzung (ca. 4 Zeichen je Token), nur für Dokumente, die gesendet werden dürfen'),
});
export type BulkEstimate = z.infer<typeof BulkEstimate>;

/** Proposed metadata for an archived document; the file and its location stay as they are (#220). */
export const ReanalysisProposal = z.object({
  documentId: Id,
  title: z.string(),
  docType: z.string().nullable(),
  summary: z.string().nullable(),
  documentDate: IsoDate.nullable(),
  topic: z.string().nullable(),
  project: z.string().nullable(),
  persons: z.array(z.string()),
  tags: z.array(z.string()),
  analyzedBy: z.enum(['llm', 'local']),
  createdAt: IsoDate,
});
export type ReanalysisProposal = z.infer<typeof ReanalysisProposal>;

/** A job's id; the job list shows its progress. */
export const StartedJob = z.object({ jobId: Id });

/** A dropped folder that is imported by a job (all supported files below it are copied into the inbox). */
export const ImportedFolder = z.object({ path: z.string(), jobId: Id });
export type ImportedFolder = z.infer<typeof ImportedFolder>;

/** How many archived documents are in the search index and how many are missing from it. */
export const IndexStatus = z.object({ documents: z.number().int().min(0), missing: z.number().int().min(0) });
export type IndexStatus = z.infer<typeof IndexStatus>;

/** Which proposals „Alle archivieren“ takes: every proposal in the inbox, or those of the scan's assignment groups. */
export const ArchiveAllSource = z.enum(['inbox', 'scan']);
export type ArchiveAllSource = z.infer<typeof ArchiveAllSource>;

/** What „Alle N Vorschläge archivieren“ would do: how many documents, into which folders, which folders are new. */
export const ArchiveAllPreview = z.object({
  previewId: Id.describe('die gezeigte Vorschau; die Bestätigung gilt genau für ihre Dokumente'),
  count: z.number().int().min(0).describe('Dokumente, die archiviert würden'),
  blocked: z.number().int().min(0).describe('Dokumente, die nicht archiviert werden können (z. B. Quelldatei fehlt)'),
  folders: z.array(z.object({ path: z.string(), count: z.number().int().min(1) })).describe('die größten Zielordner'),
  moreFolders: z.number().int().min(0).describe('weitere, hier nicht aufgeführte Zielordner'),
  newCategories: z.array(z.string()).describe('Ordner, die neu angelegt würden'),
});
export type ArchiveAllPreview = z.infer<typeof ArchiveAllPreview>;
