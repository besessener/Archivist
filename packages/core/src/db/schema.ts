import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ArchivistJson } from '../util/json';

type Json<T> = T;
const jsonArr = (name: string) => text(name, { mode: 'json' }).$type<string[]>().notNull().default([]);

/** Generic node table of the knowledge graph. Documents, decisions and open items share their id with their node. */
export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description'),
    /** Former names of entities merged into this one (display form); used to resolve later mentions. */
    aliases: jsonArr('aliases'),
    /** Roles of a person found in mentions ("Chefin", "Führungskraft"); stored as info, never part of the name. */
    roles: jsonArr('roles'),
    /** Set when the node was discarded as a duplicate („verworfen (Duplikat)“, notes and events): the entity it was merged into. */
    duplicateOfId: text('duplicate_of_id'),
    /** The user's own person („Du“); at most one entity carries the flag. */
    isSelf: integer('is_self', { mode: 'boolean' }).notNull().default(false),
    /** Topic/project taken from a document and not yet confirmed by the user: kept out of LLM prompts (#199). */
    unconfirmed: integer('unconfirmed', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('entities_type_name_idx').on(t.type, t.normalizedName)],
);

export const relations = sqliteTable(
  'relations',
  {
    id: text('id').primaryKey(),
    sourceEntityId: text('source_entity_id').notNull(),
    targetEntityId: text('target_entity_id').notNull(),
    relationType: text('relation_type').notNull(),
    confidence: real('confidence').notNull().default(0.5),
    sourceIds: jsonArr('source_ids'),
    status: text('status').notNull().default('proposed'),
    /** Set once the user explicitly confirmed or rejected the relation; such relations are never changed by field sync. */
    resolvedByUser: integer('resolved_by_user', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('relations_unique_idx').on(t.sourceEntityId, t.targetEntityId, t.relationType), index('relations_target_idx').on(t.targetEntityId)],
);

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

export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    decisionText: text('decision_text').notNull(),
    decidedAt: text('decided_at'),
    topicId: text('topic_id'),
    projectId: text('project_id'),
    participants: jsonArr('participants'),
    rationale: text('rationale'),
    consequences: text('consequences'),
    alternatives: jsonArr('alternatives'),
    status: text('status').notNull().default('draft'),
    validFrom: text('valid_from'),
    validUntil: text('valid_until'),
    supersedesDecisionId: text('supersedes_decision_id'),
    sourceIds: jsonArr('source_ids'),
    confidence: real('confidence').notNull().default(0.8),
    missingFields: jsonArr('missing_fields'),
    unknownFields: jsonArr('unknown_fields'),
    /** chat | form | document (#175); null for older decisions */
    origin: text('origin'),
    evidence: text('evidence'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('decisions_topic_idx').on(t.topicId)],
);

export const openItems = sqliteTable(
  'open_items',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    topicId: text('topic_id'),
    projectId: text('project_id'),
    responsiblePersonId: text('responsible_person_id'),
    responsibleUnknown: integer('responsible_unknown', { mode: 'boolean' }).notNull().default(false),
    dueAt: text('due_at'),
    dueUnknown: integer('due_unknown', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    sourceIds: jsonArr('source_ids'),
    reminderAt: text('reminder_at'),
    confidence: real('confidence').notNull().default(0.8),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Most recently generated solution proposal (OpenItemSolution as JSON) */
    solution: text('solution', { mode: 'json' }).$type<ArchivistJson | null>(),
    /** Set when the item was discarded as a duplicate: the open item it was merged into (status `dismissed`). */
    duplicateOfId: text('duplicate_of_id'),
    /** Optional comment given when closing: how it was solved, or why it was dropped. */
    resolutionNote: text('resolution_note'),
  },
  (t) => [index('open_items_status_idx').on(t.status)],
);

/** Dated events („am 01.10.2026 beim German Testing Day eingereicht“) – appear in the timeline. */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    occurredAt: text('occurred_at').notNull(),
    topicId: text('topic_id'),
    projectId: text('project_id'),
    /** Names of the persons involved (#274). */
    participants: jsonArr('participants'),
    sourceIds: jsonArr('source_ids'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Set when the event was discarded as a duplicate („verworfen (Duplikat)“): the event it was merged into. */
    duplicateOfId: text('duplicate_of_id'),
  },
  (t) => [index('events_occurred_idx').on(t.occurredAt)],
);

export const reminders = sqliteTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    title: text('title').notNull(),
    remindAt: text('remind_at').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('reminders_due_idx').on(t.status, t.remindAt)],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    type: text('type').notNull(),
    priority: text('priority').notNull().default('normal'),
    affectedEntityIds: jsonArr('affected_entity_ids'),
    proposedActions: text('proposed_actions', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    dedupeKey: text('dedupe_key'),
    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),
    resolvedAt: text('resolved_at'),
  },
  (t) => [uniqueIndex('notifications_dedupe_idx').on(t.dedupeKey)],
);

export const insights = sqliteTable(
  'insights',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    explanation: text('explanation').notNull(),
    confidence: real('confidence').notNull().default(0.5),
    affected: text('affected', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    sourceIds: jsonArr('source_ids'),
    recommendedActionId: text('recommended_action_id'),
    recommendedActionLabel: text('recommended_action_label'),
    /** Answer options of a question insight (`InsightChoice[]`); empty for classic accept/reject insights. */
    choices: text('choices', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    /** Id of the choice the user picked (only for insights with choices). */
    chosenChoiceId: text('chosen_choice_id'),
    status: text('status').notNull().default('open'),
    snoozedUntil: text('snoozed_until'),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('insights_dedupe_idx').on(t.dedupeKey)],
);

export const contradictions = sqliteTable(
  'contradictions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    affectedEntityIds: jsonArr('affected_entity_ids'),
    excerpts: text('excerpts', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    sourceIds: jsonArr('source_ids'),
    timestamps: jsonArr('timestamps'),
    confidence: real('confidence').notNull().default(0.5),
    status: text('status').notNull().default('detected'),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [uniqueIndex('contradictions_dedupe_idx').on(t.dedupeKey)],
);

export const agentActions = sqliteTable('agent_actions', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id'),
  actionType: text('action_type').notNull(),
  label: text('label').notNull(),
  rationale: text('rationale').notNull(),
  confidence: real('confidence').notNull().default(0.5),
  affectedEntities: text('affected_entities', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
  requiredConfirmation: text('required_confirmation').notNull().default('confirm'),
  params: text('params', { mode: 'json' }).$type<ArchivistJson>().notNull().default({}),
  status: text('status').notNull().default('proposed'),
  result: text('result'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  /** State machine for follow-up questions (e.g. missing decision details). */
  pending: text('pending', { mode: 'json' }).$type<ArchivistJson | null>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    sources: text('sources', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    context: text('context', { mode: 'json' }).$type<ArchivistJson | null>(),
    actionIds: jsonArr('action_ids'),
    confidence: real('confidence'),
    uncertainties: jsonArr('uncertainties'),
    intent: text('intent'),
    errorMessage: text('error_message'),
    quickReplies: jsonArr('quick_replies'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId, t.createdAt)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    label: text('label').notNull(),
    payload: text('payload', { mode: 'json' }).$type<ArchivistJson>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    progress: real('progress'),
    progressMessage: text('progress_message'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    error: text('error'),
    result: text('result', { mode: 'json' }).$type<ArchivistJson | null>(),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('jobs_status_idx').on(t.status, t.createdAt)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    trigger: text('trigger').notNull(),
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
    entityIds: jsonArr('entity_ids'),
    paths: jsonArr('paths'),
    before: text('before', { mode: 'json' }).$type<ArchivistJson | null>(),
    after: text('after', { mode: 'json' }).$type<ArchivistJson | null>(),
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
    undoType: text('undo_type'),
    undoData: text('undo_data', { mode: 'json' }).$type<ArchivistJson | null>(),
    undoneAt: text('undone_at'),
  },
  (t) => [index('audit_at_idx').on(t.at)],
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
    text: text('text').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }),
    embeddingModel: text('embedding_model'),
  },
  (t) => [index('chunks_entity_idx').on(t.entityId)],
);

export const llmTransmissions = sqliteTable('llm_transmissions', {
  id: text('id').primaryKey(),
  at: text('at').notNull(),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  endpoint: text('endpoint').notNull(),
  bytes: integer('bytes').notNull(),
  redactions: integer('redactions').notNull().default(0),
  documentIds: jsonArr('document_ids'),
  preview: text('preview').notNull().default(''),
  success: integer('success', { mode: 'boolean' }).notNull().default(true),
});

export type { Json };

/** Small key-value store for application state that must survive restarts (e.g. when a periodic task last ran). */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
