import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ArchivistJson } from '../../util/json';
import { jsonArr } from './columns';

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
    /** Agent run that produced the answer (#300). */
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId, t.createdAt)],
);

/** Agent runs (#299): trigger, provider, tool calls with shortened results, tokens, cost, duration and outcome. */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id'),
    trigger: text('trigger').notNull(),
    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    summary: text('summary').notNull().default(''),
    steps: text('steps', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    usage: text('usage', { mode: 'json' }).$type<ArchivistJson>().notNull().default({}),
    costUsd: real('cost_usd'),
    rounds: integer('rounds').notNull().default(0),
    applied: text('applied', { mode: 'json' }).$type<ArchivistJson>().notNull().default([]),
    files: jsonArr('files'),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('agent_runs_started_idx').on(t.startedAt), index('agent_runs_conv_idx').on(t.conversationId)],
);

/** Provider-neutral agent history per conversation (append-only, #297); `raw` is replayed only to the same provider and model. */
export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    seq: integer('seq').notNull(),
    runId: text('run_id'),
    data: text('data', { mode: 'json' }).$type<ArchivistJson>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('agent_messages_seq_idx').on(t.conversationId, t.seq)],
);

/** What Archivist has learned (#315): rules, workflows, corrections, preferences and facts. Visible and deletable. */
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    content: text('content').notNull(),
    data: text('data', { mode: 'json' }).$type<ArchivistJson | null>(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    origin: text('origin').notNull().default('user'),
    timesApplied: integer('times_applied').notNull().default(0),
    lastAppliedAt: text('last_applied_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('agent_memory_kind_idx').on(t.kind)],
);
