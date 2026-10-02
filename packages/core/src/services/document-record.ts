import type { DocumentProposal, DocumentRecord, DocumentStatus, LlmStatus } from '@archivist/shared';
import { MIME_BY_EXT } from '../parsers';
import { truncate } from '../util/text';
import type { DocRow } from './document-model';

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
}

/** Row of a freshly recorded document: not analyzed, not archived. */
export function newDocumentRow(input: NewDocument, created: { id: string; at: string }): DocRow {
  return {
    id: created.id,
    title: input.originalName.replace(/\.[^.]+$/, ''),
    originalName: input.originalName,
    ext: input.ext,
    mime: MIME_BY_EXT[input.ext] ?? 'application/octet-stream',
    size: input.size,
    sha256: input.sha256,
    sourcePath: input.sourcePath,
    stagedPath: input.stagedPath,
    archiveRelPath: null,
    status: input.status ?? 'staged',
    processingStatus: 'pending',
    processingError: input.processingError ?? null,
    docType: null,
    summary: null,
    categoryPath: null,
    topicId: null,
    projectId: null,
    persons: [],
    tags: [],
    dates: [],
    documentDate: null,
    confidence: null,
    llmStatus: input.llmStatus ?? 'pending',
    folderLlmAllowed: input.folderLlmAllowed ?? true,
    proposal: null,
    archiveMode: null,
    extractedText: '',
    technicalMeta: null,
    textHash: null,
    createdAt: created.at,
    updatedAt: created.at,
    archivedAt: null,
  };
}

/** The record the renderer sees; `textLength` is the full length when `r.extractedText` holds only its beginning. */
export function documentRecord(
  r: DocRow,
  resolved: { archivePath: string | null; nameOf: (id: string | null) => string | null; textLength: number },
): DocumentRecord {
  return {
    id: r.id,
    title: r.title,
    originalName: r.originalName,
    ext: r.ext,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    sourcePath: r.sourcePath,
    stagedPath: r.stagedPath,
    archiveRelPath: r.archiveRelPath,
    archivePath: resolved.archivePath,
    status: r.status as DocumentStatus,
    processingStatus: r.processingStatus as DocumentRecord['processingStatus'],
    processingError: r.processingError,
    docType: r.docType,
    summary: r.summary,
    categoryPath: r.categoryPath,
    topicId: r.topicId,
    topicName: resolved.nameOf(r.topicId),
    projectId: r.projectId,
    projectName: resolved.nameOf(r.projectId),
    persons: r.persons,
    tags: r.tags,
    dates: r.dates,
    documentDate: r.documentDate,
    confidence: r.confidence,
    llmStatus: r.llmStatus as LlmStatus,
    folderLlmAllowed: r.folderLlmAllowed,
    proposal: (r.proposal as DocumentProposal | null) ?? null,
    archiveMode: (r.archiveMode as DocumentRecord['archiveMode']) ?? null,
    textLength: resolved.textLength,
    textPreview: truncate(r.extractedText.replace(/\s+/g, ' ').trim(), 600),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

/** Search text of a document: its metadata lines, then its full text. */
export function searchContent(r: DocRow, names: Map<string, string>): string {
  const meta = [
    r.docType && `Typ: ${r.docType}`,
    r.topicId && `Thema: ${names.get(r.topicId)}`,
    r.projectId && `Projekt: ${names.get(r.projectId)}`,
    r.persons.length ? `Personen: ${r.persons.join(', ')}` : '',
    r.tags.length ? `Tags: ${r.tags.join(', ')}` : '',
    r.summary,
  ]
    .filter(Boolean)
    .join('\n');
  return `${meta}\n\n${r.extractedText}`;
}
