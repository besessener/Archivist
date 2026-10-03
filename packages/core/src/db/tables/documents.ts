import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ArchivistJson } from '../../util/json';
import { jsonArr } from './columns';

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    originalName: text('original_name').notNull(),
    ext: text('ext').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    sourcePath: text('source_path'),
    stagedPath: text('staged_path'),
    archiveRelPath: text('archive_rel_path'),
    status: text('status').notNull().default('staged'),
    processingStatus: text('processing_status').notNull().default('pending'),
    processingError: text('processing_error'),
    docType: text('doc_type'),
    summary: text('summary'),
    categoryPath: text('category_path'),
    topicId: text('topic_id'),
    projectId: text('project_id'),
    persons: jsonArr('persons'),
    tags: jsonArr('tags'),
    dates: jsonArr('dates'),
    /** Date of the document itself (letter, meeting, invoice date) – not the archive date (#168). */
    documentDate: text('document_date'),
    confidence: real('confidence'),
    llmStatus: text('llm_status').notNull().default('pending'),
    /** false: the document lies in a scan folder without LLM permission – nothing of it may reach the LLM. */
    folderLlmAllowed: integer('folder_llm_allowed', { mode: 'boolean' }).notNull().default(true),
    proposal: text('proposal', { mode: 'json' }).$type<ArchivistJson | null>(),
    archiveMode: text('archive_mode'),
    extractedText: text('extracted_text').notNull().default(''),
    technicalMeta: text('technical_meta', { mode: 'json' }).$type<ArchivistJson | null>(),
    /** Hash of the normalized text start (near-duplicate detection); a column with an index instead of a JSON field (#212). */
    textHash: text('text_hash'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (t) => [
    index('documents_sha_idx').on(t.sha256),
    index('documents_status_idx').on(t.status),
    index('documents_topic_idx').on(t.topicId),
    index('documents_text_hash_idx').on(t.textHash),
    index('documents_created_idx').on(t.createdAt),
  ],
);

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  approved: integer('approved', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    idx: integer('idx').notNull(),
    /** Title of the entry at indexing time: weighted column of the full-text index, which reads chunk text and title from here. */
    title: text('title').notNull().default(''),
    text: text('text').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }),
    embeddingModel: text('embedding_model'),
    /** Local hash vector kept next to a remote one, so the entry stays findable by the local pass when the endpoint is gone (#173). */
    localEmbedding: blob('local_embedding', { mode: 'buffer' }),
  },
  (t) => [index('chunks_entity_idx').on(t.entityId)],
);

export const scanRoots = sqliteTable('scan_roots', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  recursive: integer('recursive', { mode: 'boolean' }).notNull().default(true),
  excludedSubdirs: jsonArr('excluded_subdirs'),
  extensions: jsonArr('extensions'),
  maxFileSizeMb: real('max_file_size_mb').notNull().default(50),
  llmAllowed: integer('llm_allowed', { mode: 'boolean' }).notNull().default(true),
  lastScanAt: text('last_scan_at'),
  lastSummary: text('last_summary', { mode: 'json' }).$type<ArchivistJson | null>(),
  createdAt: text('created_at').notNull(),
});

export const scanFiles = sqliteTable(
  'scan_files',
  {
    id: text('id').primaryKey(),
    rootId: text('root_id').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    ext: text('ext').notNull(),
    size: integer('size').notNull(),
    mtimeMs: real('mtime_ms').notNull(),
    sha256: text('sha256'),
    mime: text('mime').notNull(),
    status: text('status').notNull().default('new'),
    llmStatus: text('llm_status').notNull().default('local_only'),
    documentId: text('document_id'),
    duplicateOfDocumentId: text('duplicate_of_document_id'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [uniqueIndex('scan_files_path_idx').on(t.rootId, t.path), index('scan_files_status_idx').on(t.status)],
);

export const scanExclusions = sqliteTable(
  'scan_exclusions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    path: text('path').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('scan_exclusions_idx').on(t.kind, t.path)],
);
