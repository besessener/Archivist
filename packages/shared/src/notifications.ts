import { z } from 'zod';
import { EntityRef, Id, IsoDate } from './common';
import { Priority } from './open-items';

export const Reminder = z.object({
  id: Id,
  targetType: z.enum(['open_item', 'insight', 'notification', 'decision', 'document', 'custom']),
  targetId: z.string().nullable(),
  title: z.string(),
  remindAt: IsoDate,
  status: z.enum(['pending', 'fired', 'dismissed']),
  createdAt: IsoDate,
});
export type Reminder = z.infer<typeof Reminder>;

export const NotificationType = z.enum([
  'open_item_due',
  'open_item_overdue',
  'open_item_no_owner',
  'open_item_no_due',
  'contradiction',
  'assignment_proposal',
  'incomplete_decision',
  'duplicate',
  'consistency_done',
  'import_failed',
  'scan_new_files',
  'scan_done',
  'scan_partial',
  'file_changed',
  'external_duplicate',
  'external_related',
  'file_has_decision',
  'file_has_open_item',
  'reminder',
  'classification_ready',
  'system',
  /** One bundled notification per background run of the agent (#313). */
  'agent_run',
  /** Deadline watcher and weekly review (#314). */
  'deadline_watch',
  'weekly_review',
]);
export type NotificationType = z.infer<typeof NotificationType>;
export const AppNotification = z.object({
  id: Id,
  title: z.string(),
  description: z.string(),
  createdAt: IsoDate,
  type: NotificationType,
  priority: Priority,
  affectedEntityIds: z.array(z.string()),
  proposedActions: z.array(
    z.object({ label: z.string(), kind: z.enum(['open', 'resolve', 'snooze', 'ignore', 'confirm_action', 'navigate']), target: z.string().nullish() }),
  ),
  readAt: IsoDate.nullable(),
  resolvedAt: IsoDate.nullable(),
});
export type AppNotification = z.infer<typeof AppNotification>;

export const InsightKind = z.enum([
  'assignment',
  'archive_proposal',
  'contradiction',
  'open_item',
  'incomplete_decision',
  'duplicate',
  'similar_topics',
  'similar_entities',
  'orphan_document',
  'outdated_info',
  'missing_metadata',
  'external_file',
  'possibly_superseded',
  'misplaced_file',
  'scattered_documents',
  'low_confidence_relation',
  'topic_project_name',
  'persons_merged',
  'unclear_person',
  /** Several similar corrections of the agent: shall Archivist store a rule? (#315) */
  'learned_rule',
  /** Similar entries without a topic: „Neues Thema ‚…‘ anlegen?“ (#281) */
  'topic_cluster',
  /** Entries without any link, with proposed targets (#290) */
  'orphan_entries',
]);
export type InsightKind = z.infer<typeof InsightKind>;
/** Answer option of a question insight: with an `actionId` it runs that action (confirmed); without one it rejects the insight for good. */
export const InsightChoice = z.object({
  /** Stable id within the insight (e.g. `project`, `topic`, `different`, an entity id). */
  id: z.string().min(1).max(100),
  label: z.string(),
  /** What happens when this option is chosen (shown before confirming). */
  description: z.string().nullable(),
  /** Agent action executed on this choice; `null` = nothing changes, the insight is rejected and remembered. */
  actionId: z.string().nullable(),
});
export type InsightChoice = z.infer<typeof InsightChoice>;
export const Insight = z.object({
  id: Id,
  kind: InsightKind,
  title: z.string(),
  explanation: z.string(),
  confidence: z.number(),
  affected: z.array(EntityRef),
  sourceIds: z.array(z.string()),
  recommendedActionId: z.string().nullable(),
  recommendedActionLabel: z.string().nullable(),
  /** Answer options; non-empty turns the insight into a question that is answered via `insights:respond` `choose`. */
  choices: z.array(InsightChoice),
  /** The option the user picked (set once the question was answered). */
  chosenChoiceId: z.string().nullable(),
  status: z.enum(['open', 'accepted', 'rejected', 'snoozed']),
  snoozedUntil: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Insight = z.infer<typeof Insight>;

export const Contradiction = z.object({
  id: Id,
  title: z.string(),
  description: z.string(),
  affectedEntityIds: z.array(z.string()),
  excerpts: z.array(z.object({ entityId: z.string(), text: z.string() })),
  sourceIds: z.array(z.string()),
  timestamps: z.array(z.string()),
  confidence: z.number(),
  status: z.enum(['detected', 'acknowledged', 'resolved', 'false_positive']),
  createdAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
});
export type Contradiction = z.infer<typeof Contradiction>;
