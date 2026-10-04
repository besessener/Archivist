import { z } from 'zod';
import { Confidence, Id, IsoDate } from './common';
import { DecisionKind } from './decisions';

export const DocumentStatus = z.enum(['staged', 'analyzing', 'proposed', 'archived', 'indexed_only', 'ignored', 'failed', 'quarantined']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;
export const ProcessingStatus = z.enum(['pending', 'extracted', 'partial', 'unsupported', 'failed']);
export const LlmStatus = z.enum(['local_only', 'pending', 'analyzed', 'excluded']);
export type LlmStatus = z.infer<typeof LlmStatus>;
export const ArchiveMode = z.enum(['copy', 'move', 'index_only', 'ignore']);
export type ArchiveMode = z.infer<typeof ArchiveMode>;
export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'markdown', 'eml', 'png', 'jpg', 'jpeg'] as const;

export const ArchiveLocationProposal = z.object({
  categoryPath: z.string().min(1).describe('Relativer, menschenlesbarer Ordnerpfad, z. B. Arbeit/Projekte/prod-plat'),
  fileName: z.string().nullish(),
  newMainCategory: z.boolean().default(false),
  rationale: z.string().default(''),
  confidence: Confidence,
});
export type ArchiveLocationProposal = z.infer<typeof ArchiveLocationProposal>;

/** Where reading a document stops; the parsers enforce these and the coverage notes name them. */
export const EXTRACTION_LIMITS = { textChars: 400_000, pdfPages: 300, ocrPages: 40 } as const;

/** How much of a long document the analysis actually saw (#190). */
export const AnalysisCoverage = z.object({
  /** Length of the extracted text. */
  textChars: z.number().int().min(0),
  /** Characters of it the LLM read in all its requests; 0 for a local analysis. */
  llmChars: z.number().int().min(0),
  /** Number of LLM requests (parts) the text was read in. */
  llmParts: z.number().int().min(0),
  /** The extraction itself stopped at its limit (`EXTRACTION_LIMITS`): the rest is neither analysed nor searchable. */
  extractionTruncated: z.boolean(),
  /** Scanned PDF pages left without OCR because of the page limit (0 for rows stored before this field existed, #226). */
  ocrPagesSkipped: z.number().int().min(0).default(0),
});
export type AnalysisCoverage = z.infer<typeof AnalysisCoverage>;

export const DocumentProposal = z.object({
  location: ArchiveLocationProposal,
  topic: z.string().nullable(),
  project: z.string().nullable(),
  persons: z.array(z.string()),
  tags: z.array(z.string()),
  possibleDecisions: z.array(
    z.object({
      title: z.string(),
      decisionText: z.string(),
      decidedAt: z.string().nullish(),
      kind: DecisionKind.nullish(),
      /** The sentence of the document that states the decision, verbatim (checked against the text). */
      evidence: z.string().nullish(),
      /** Who took this decision according to the document – not simply everyone the document names (#178). */
      participants: z.array(z.string()).nullish(),
    }),
  ),
  possibleOpenItems: z.array(
    z.object({ title: z.string(), description: z.string().nullish(), dueAt: z.string().nullish(), responsible: z.string().nullish() }),
  ),
  duplicateOfDocumentId: z.string().nullable(),
  analyzedBy: z.enum(['llm', 'local']),
  coverage: AnalysisCoverage.optional(),
});
export type DocumentProposal = z.infer<typeof DocumentProposal>;

export const DocumentRecord = z.object({
  id: Id,
  title: z.string(),
  originalName: z.string(),
  ext: z.string(),
  mime: z.string(),
  size: z.number(),
  sha256: z.string(),
  sourcePath: z.string().nullable(),
  stagedPath: z.string().nullable(),
  archiveRelPath: z.string().nullable(),
  archivePath: z.string().nullable().describe('absoluter Pfad im Archiv (abgeleitet)'),
  status: DocumentStatus,
  processingStatus: ProcessingStatus,
  processingError: z.string().nullable(),
  docType: z.string().nullable(),
  summary: z.string().nullable(),
  categoryPath: z.string().nullable(),
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  persons: z.array(z.string()),
  tags: z.array(z.string()),
  dates: z.array(z.string()),
  documentDate: IsoDate.nullable().describe('Datum des Dokuments selbst (Brief-, Sitzungs-, Rechnungsdatum), nicht das Archivierungsdatum'),
  confidence: z.number().nullable(),
  llmStatus: LlmStatus,
  folderLlmAllowed: z.boolean().describe('false: liegt in einem Scan-Verzeichnis ohne KI-Freigabe'),
  proposal: DocumentProposal.nullable(),
  archiveMode: ArchiveMode.nullable(),
  textLength: z.number(),
  textPreview: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  archivedAt: IsoDate.nullable(),
});
export type DocumentRecord = z.infer<typeof DocumentRecord>;

/** A document in the trash: restorable until the trash is emptied. */
export const TrashEntry = z.object({
  auditId: Id,
  documentId: Id,
  title: z.string(),
  trashedAt: IsoDate,
  files: z.array(z.string()),
});
export type TrashEntry = z.infer<typeof TrashEntry>;
