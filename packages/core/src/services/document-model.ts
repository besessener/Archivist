import path from 'node:path';
import type { DocumentRecord, DocumentStatus, LlmStatus } from '@archivist/shared';
import type { AppContext } from '../context';
import type { documents } from '../db/schema';
import type { ParsedDocument } from '../parsers/parsed-document';
import { sha256Text } from '../util/hash';
import { normalizeName } from '../util/text';
import type { WorkerPool } from '../workers/pool';
import type { AuditService } from './audit';
import type { CategoryService } from './categories';
import type { DocumentListQuery } from './document-queries';
import type { JobQueueService } from './jobs';
import type { NearDuplicateIndex } from './near-duplicates';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { LlmService } from './llm';
import type { NotificationService } from './notifications';
import type { PersonService } from './persons';
import type { PrivacyService } from './privacy';
import type { SearchService } from './search';
import type { SettingsService } from './settings';

export type DocRow = typeof documents.$inferSelect;

/** Final states an analysis must never reopen (the file already lives in the archive or index). */
export const ARCHIVED_STATUSES: DocumentStatus[] = ['archived', 'indexed_only'];

export const isArchivedStatus = (status: string): boolean => ARCHIVED_STATUSES.includes(status as DocumentStatus);

export interface NewDocument {
  originalName: string;
  ext: string;
  size: number;
  sha256: string;
  sourcePath: string | null;
  stagedPath: string | null;
  llmStatus?: LlmStatus;
  /** false: the file comes from a scan folder without LLM permission */
  folderLlmAllowed?: boolean;
  status?: Extract<DocumentStatus, 'staged' | 'quarantined'>;
  processingError?: string | null;
  /** Preset for the document date (YYYY-MM-DD) until an analysis finds a date in the content. */
  documentDate?: string | null;
}

/** What the parts of the document service use of the service itself (typed by shape to keep the modules acyclic). */
export interface DocumentAccess {
  findRow(id: string): DocRow | undefined;
  getRow(id: string): DocRow;
  get(id: string): DocumentRecord;
  list(opts: DocumentListQuery): DocumentRecord[];
  findDuplicates(sha256: string, excludeId?: string): DocRow[];
  insertDocument(input: NewDocument): DocumentRecord;
  folderLlmAllowedFor(p: string): boolean;
  readablePath(r: DocRow): string;
  indexDocument(id: string): Promise<void>;
  /** Re-indexes in the background, a few at a time (bulk changes). */
  indexDocumentsInBackground(ids: string[]): void;
  archivePath(rel: string | null): string | null;
}

/** Services the parts of the document service work with; `documents` is the service itself. */
export interface DocumentDeps {
  ctx: AppContext;
  settings: SettingsService;
  graph: KnowledgeGraphService;
  persons: PersonService;
  search: SearchService;
  llm: LlmService;
  privacy: PrivacyService;
  pool: WorkerPool;
  audit: AuditService;
  notifications: NotificationService;
  categories: CategoryService;
  jobs: JobQueueService;
  documents: DocumentAccess;
  nearDuplicates: NearDuplicateIndex;
}

/** Extracts the text of a file in the worker (with OCR as configured). */
export function extractFile(deps: Pick<DocumentDeps, 'ctx' | 'settings' | 'pool'>, file: string, signal?: AbortSignal): Promise<ParsedDocument> {
  const payload = {
    path: file,
    options: {
      ocrEnabled: deps.settings.get().ocr.enabled,
      ocrLanguages: deps.settings.get().ocr.languages,
      tessdataDir: path.join(deps.ctx.paths.index, 'tessdata'),
    },
  };
  return deps.pool.run('extractDocument', payload, { signal });
}

/** Hash of the normalized text for duplicate detection; null for texts too short to compare. */
const textHashOf = (text: string): string | null => (text.length > 200 ? sha256Text(normalizeName(text).slice(0, 20_000)) : null);

/** Columns that store an extraction result. */
export function extractedColumns(parsed: ParsedDocument) {
  const textHash = textHashOf(parsed.text);
  return {
    extractedText: parsed.text,
    textHash,
    processingStatus: parsed.status,
    processingError: parsed.error,
    technicalMeta: { ...parsed.meta, truncated: parsed.truncated, textHash },
  };
}
