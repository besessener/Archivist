import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ArchivistJson } from '../../util/json';
import { jsonArr } from './columns';

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
  (t) => [uniqueIndex('insights_dedupe_idx').on(t.dedupeKey), index('insights_status_updated_idx').on(t.status, t.updatedAt)],
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
    /** Resolved by superseding one decision: only undoing that supersede raises the contradiction again. */
    resolvedBySupersede: integer('resolved_by_supersede', { mode: 'boolean' }).notNull().default(false),
    /** Resolved only because a decision was no longer active: it is raised again once both are active. */
    resolvedByDeactivation: integer('resolved_by_deactivation', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('contradictions_dedupe_idx').on(t.dedupeKey)],
);

/** The LLM's verdict on a pair of decision texts, keyed by the hash of both texts, so a pair is never asked about twice. */
export const contradictionReviews = sqliteTable('contradiction_reviews', {
  textHash: text('text_hash').primaryKey(),
  isContradiction: integer('is_contradiction', { mode: 'boolean' }).notNull(),
  reviewedAt: text('reviewed_at').notNull(),
});
