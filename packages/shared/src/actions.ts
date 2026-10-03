import { z } from 'zod';
import { Confidence, EntityRef, Id, IsoDate, RelationType } from './common';
import { ArchiveItemRequest } from './archive';
import { DecisionKind } from './decisions';

export const AgentActionType = z.enum([
  'archive_documents',
  'relocate_documents',
  'assign_documents',
  'supersede_decision',
  'revoke_decision',
  'resolve_contradiction',
  'close_open_item',
  'merge_topics',
  'merge_entities',
  'merge_notes',
  'merge_events',
  'confirm_relation',
  'reject_relation',
  /** Links two entries as the user's confirmed choice, e.g. „Unterthema von“ (#282). */
  'link_entities',
  'exclude_path',
  'create_category',
  'set_reminder',
  'create_open_item',
  'add_open_item_source',
  'merge_open_items',
  'record_decision',
  'undo_change',
  /** Changes an agent run prepared as proposals (mode „Fragen“ or critical, #298); confirmable as a whole or in part. */
  'agent_batch',
]);
export type AgentActionType = z.infer<typeof AgentActionType>;
export const ConfirmationLevel = z.enum(['none', 'confirm', 'strong']);

export const AgentActionProposal = z.object({
  actionType: AgentActionType,
  rationale: z.string(),
  confidence: Confidence,
  affectedEntities: z.array(EntityRef),
  requiredConfirmation: ConfirmationLevel,
  proposedParameters: z.record(z.string(), z.unknown()),
});
export type AgentActionProposal = z.infer<typeof AgentActionProposal>;

/** `withdrawn`: the proposal was retracted without a user decision (its cause is gone or a newer proposal replaced it). */
export const AgentActionStatus = z.enum(['proposed', 'approved', 'rejected', 'executed', 'failed', 'withdrawn']);
export type AgentActionStatus = z.infer<typeof AgentActionStatus>;

export const StoredAgentAction = AgentActionProposal.extend({
  id: Id,
  conversationId: z.string().nullable(),
  label: z.string(),
  status: AgentActionStatus,
  result: z.string().nullable(),
  createdAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
});
export type StoredAgentAction = z.infer<typeof StoredAgentAction>;

/** Parameter schemas per action type (runtime validation before execution). */
export const ActionParamSchemas = {
  archive_documents: z.object({
    items: z.array(ArchiveItemRequest).min(1),
    approveNewCategories: z.array(z.string()).default([]),
  }),
  /** Moves already archived documents to another folder inside the archive. */
  relocate_documents: z.object({
    items: z
      .array(
        z.object({
          documentId: Id,
          categoryPath: z.string().min(1),
          /** archive path at proposal time; if the document was moved since, the proposal is stale */
          fromRelPath: z.string().optional(),
        }),
      )
      .min(1),
  }),
  assign_documents: z.object({
    documentIds: z.array(Id).min(1),
    topic: z.string().nullish(),
    project: z.string().nullish(),
  }),
  supersede_decision: z.object({ oldDecisionId: Id, newDecisionId: Id }),
  revoke_decision: z.object({ decisionId: Id }),
  resolve_contradiction: z.object({
    contradictionId: Id,
    resolution: z.enum(['acknowledged', 'resolved', 'false_positive']),
    supersedeOldDecisionId: Id.optional(),
    supersedeNewDecisionId: Id.optional(),
  }),
  close_open_item: z.object({
    openItemId: Id,
    status: z.enum(['resolved', 'dismissed']).default('resolved'),
    resolutionNote: z.string().max(4000).nullish(),
  }),
  merge_topics: z.object({ sourceTopicId: Id, targetTopicId: Id }),
  /** Generic merge (topics, projects, persons, tags); `allowCrossType` merges a topic into a project or vice versa (target type wins). */
  merge_entities: z.object({ sourceIds: z.array(Id).min(1), targetId: Id, allowCrossType: z.boolean().default(false) }),
  /** Duplicate notes: keep `keepId`, take over its missing links from `duplicateId`, discard that one as a duplicate (undoable). */
  merge_notes: z.object({ keepId: Id, duplicateId: Id }),
  /** Duplicate events: keep `keepId`, take over its missing details from `duplicateId`, discard that one as a duplicate (undoable). */
  merge_events: z.object({ keepId: Id, duplicateId: Id }),
  /** `offered`: a link suggestion after capturing in the chat (#283), shown as a compact button. */
  confirm_relation: z.object({ relationId: Id, offered: z.boolean().optional() }),
  reject_relation: z.object({ relationId: Id }),
  link_entities: z.object({ sourceId: Id, targetId: Id, relationType: RelationType }),
  exclude_path: z.object({ kind: z.enum(['file', 'dir']), path: z.string() }),
  create_category: z.object({ path: z.string() }),
  set_reminder: z.object({ targetType: z.string(), targetId: z.string().nullable(), title: z.string(), remindAt: IsoDate }),
  create_open_item: z.object({
    title: z.string(),
    description: z.string().nullish(),
    dueAt: z.string().nullish(),
    responsible: z.string().nullish(),
    sourceIds: z.array(z.string()).default([]),
    topic: z.string().nullish(),
    project: z.string().nullish(),
  }),
  /** Adds another document as a source to an existing open item (instead of creating it twice). */
  add_open_item_source: z.object({
    openItemId: Id,
    documentId: Id,
    description: z.string().nullish(),
    dueAt: z.string().nullish(),
    responsible: z.string().nullish(),
  }),
  /** Duplicate open items: keep `keepId`, take over its missing details from `duplicateId`, discard that one as a duplicate (undoable). */
  merge_open_items: z.object({ keepId: Id, duplicateId: Id }),
  /** Undoes a recorded change (audit entry), e.g. an automatic merge of person duplicates. */
  undo_change: z.object({ auditId: Id }),
  agent_batch: z.object({
    runId: Id,
    conversationId: z.string().nullish(),
    items: z
      .array(z.object({ tool: z.string(), args: z.unknown(), label: z.string(), risk: z.enum(['read', 'write', 'critical']), reason: z.string().default('') }))
      .min(1),
    /** Short ids (D1, S1 …) as they were when the proposal was made. */
    refs: z.object({ ids: z.record(z.string(), z.string()), sets: z.record(z.string(), z.array(z.string())) }).default({ ids: {}, sets: {} }),
    /** Partial confirmation: indexes of the items to execute (all when absent). */
    selected: z.array(z.number().int().min(0)).optional(),
  }),
  record_decision: z.object({
    title: z.string(),
    decisionText: z.string(),
    decidedAt: z.string().nullish(),
    participants: z.array(z.string()).default([]),
    topic: z.string().nullish(),
    project: z.string().nullish(),
    sourceIds: z.array(z.string()).default([]),
    kind: DecisionKind.nullish(),
    evidence: z.string().nullish(),
  }),
} as const;
