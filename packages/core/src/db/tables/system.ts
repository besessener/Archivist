import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ArchivistJson } from '../../util/json';
import { jsonArr } from './columns';

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
    /** Agent run during which the change was made (#299); null for changes outside of a run. */
    runId: text('run_id'),
    /** Hash of the entry's fixed fields and `prevHash` (chain, #193); null for entries from before the chain. */
    hash: text('hash'),
    prevHash: text('prev_hash'),
  },
  (t) => [index('audit_at_idx').on(t.at), index('audit_run_idx').on(t.runId)],
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
  /** Tokens of the request as reported by the provider (agent requests, #302); null for older entries. */
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
});

/** Small key-value store for application state that must survive restarts (e.g. when a periodic task last ran). */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
