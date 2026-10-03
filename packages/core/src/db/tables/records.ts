import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ArchivistJson } from '../../util/json';
import { jsonArr } from './columns';

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
