import { z } from 'zod';
import { Confidence, EntityRef, EntityType, Id, IsoDate, patchSchema, RelationStatus, RelationType, SourceReference } from './common';

// ---------- Documents ----------
export const DocumentStatus = z.enum(['staged', 'analyzing', 'proposed', 'archived', 'indexed_only', 'ignored', 'failed', 'quarantined']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;
export const ProcessingStatus = z.enum(['pending', 'extracted', 'partial', 'unsupported', 'failed']);
export const LlmStatus = z.enum(['local_only', 'pending', 'analyzed', 'excluded']);
export type LlmStatus = z.infer<typeof LlmStatus>;
export const ArchiveMode = z.enum(['copy', 'move', 'index_only', 'ignore']);
export type ArchiveMode = z.infer<typeof ArchiveMode>;
export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'markdown', 'eml', 'png', 'jpg', 'jpeg'] as const;

export const ArchiveLocationProposal = z.object({
  categoryPath: z.string().min(1).describe('Relativer, menschenlesbarer Ordnerpfad, z. B. work/projects/prod-plat'),
  fileName: z.string().nullish(),
  newMainCategory: z.boolean().default(false),
  rationale: z.string().default(''),
  confidence: Confidence,
});
export type ArchiveLocationProposal = z.infer<typeof ArchiveLocationProposal>;

/** What a document says about a decision: only `decided` (and `rejected`) are decisions; the rest was only talked about (#175). */
export const DecisionKind = z.enum(['decided', 'proposed', 'discussed', 'postponed', 'rejected']);
export type DecisionKind = z.infer<typeof DecisionKind>;
/** Where a decision was captured: dictated in the chat, entered in the form, or taken from a document. */
export const DecisionOrigin = z.enum(['chat', 'form', 'document']);
export type DecisionOrigin = z.infer<typeof DecisionOrigin>;

export const DocumentProposal = z.object({
  location: ArchiveLocationProposal,
  topic: z.string().nullable(),
  project: z.string().nullable(),
  persons: z.array(z.string()),
  tags: z.array(z.string()),
  possibleDecisions: z.array(
    z.object({
      title: z.string(),
      decisionText: z.string(),
      decidedAt: z.string().nullish(),
      kind: DecisionKind.nullish(),
      /** The sentence of the document that states the decision, verbatim (checked against the text). */
      evidence: z.string().nullish(),
      /** Who took this decision according to the document – not simply everyone the document names (#178). */
      participants: z.array(z.string()).nullish(),
    }),
  ),
  possibleOpenItems: z.array(
    z.object({ title: z.string(), description: z.string().nullish(), dueAt: z.string().nullish(), responsible: z.string().nullish() }),
  ),
  duplicateOfDocumentId: z.string().nullable(),
  analyzedBy: z.enum(['llm', 'local']),
});
export type DocumentProposal = z.infer<typeof DocumentProposal>;

export const DocumentRecord = z.object({
  id: Id,
  title: z.string(),
  originalName: z.string(),
  ext: z.string(),
  mime: z.string(),
  size: z.number(),
  sha256: z.string(),
  sourcePath: z.string().nullable(),
  stagedPath: z.string().nullable(),
  archiveRelPath: z.string().nullable(),
  archivePath: z.string().nullable().describe('absoluter Pfad im Archiv (abgeleitet)'),
  status: DocumentStatus,
  processingStatus: ProcessingStatus,
  processingError: z.string().nullable(),
  docType: z.string().nullable(),
  summary: z.string().nullable(),
  categoryPath: z.string().nullable(),
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  persons: z.array(z.string()),
  tags: z.array(z.string()),
  dates: z.array(z.string()),
  documentDate: IsoDate.nullable().describe('Datum des Dokuments selbst (Brief-, Sitzungs-, Rechnungsdatum), nicht das Archivierungsdatum'),
  confidence: z.number().nullable(),
  llmStatus: LlmStatus,
  folderLlmAllowed: z.boolean().describe('false: liegt in einem Scan-Verzeichnis ohne KI-Freigabe'),
  proposal: DocumentProposal.nullable(),
  archiveMode: ArchiveMode.nullable(),
  textLength: z.number(),
  textPreview: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  archivedAt: IsoDate.nullable(),
});
export type DocumentRecord = z.infer<typeof DocumentRecord>;

export const ArchivePlanItem = z.object({
  documentId: Id,
  title: z.string(),
  action: ArchiveMode,
  sourcePath: z.string().nullable(),
  targetPath: z.string().nullable(),
  targetRelPath: z.string().nullable(),
  renamed: z.boolean(),
  /** True only when a file outside Archivist (the user's original) gets deleted, i.e. on move. */
  willRemoveSource: z.boolean(),
  /** True when Archivist's own temporary inbox copy gets cleaned up afterwards (the original is untouched). */
  removesInboxCopy: z.boolean(),
  duplicates: z.array(z.object({ documentId: Id, title: z.string(), archivePath: z.string().nullable() })),
  conflicts: z.array(z.string()),
  newCategories: z.array(z.string()),
  affected: z.array(EntityRef),
  rationale: z.string(),
  confidence: z.number().nullable(),
  blocked: z.boolean(),
});
export type ArchivePlanItem = z.infer<typeof ArchivePlanItem>;
export const ArchivePlan = z.object({
  items: z.array(ArchivePlanItem),
  newCategories: z.array(z.string()),
  requiresStrongConfirmation: z.boolean(),
  summary: z.string(),
});
export type ArchivePlan = z.infer<typeof ArchivePlan>;

export const ArchiveItemRequest = z.object({
  documentId: Id,
  mode: ArchiveMode.default('copy'),
  categoryPath: z.string().optional(),
  fileName: z.string().optional(),
  /** Omitted: use the proposal. `null` (or an empty string): explicitly without topic. */
  topic: z.string().nullish(),
  /** Omitted: use the proposal. `null` (or an empty string): explicitly without project. */
  project: z.string().nullish(),
});
export type ArchiveItemRequest = z.infer<typeof ArchiveItemRequest>;

export const ArchiveResultItem = z.object({
  documentId: Id,
  outcome: z.enum(['success', 'skipped', 'failed', 'conflict']),
  targetPath: z.string().nullable(),
  message: z.string(),
  auditId: z.string().nullable(),
});
export const ArchiveResult = z.object({
  items: z.array(ArchiveResultItem),
  success: z.number(),
  skipped: z.number(),
  failed: z.number(),
  conflicts: z.number(),
});
export type ArchiveResult = z.infer<typeof ArchiveResult>;

// ---------- Decisions ----------
export const DecisionStatus = z.enum(['draft', 'confirmed', 'active', 'superseded', 'revoked', 'unclear']);
export type DecisionStatus = z.infer<typeof DecisionStatus>;
export const DecisionField = z.enum(['decidedAt', 'topic', 'participants', 'decisionText']);
export type DecisionField = z.infer<typeof DecisionField>;
export const DECISION_FIELD_LABELS: Record<DecisionField, string> = {
  decidedAt: 'Wann',
  topic: 'Thema',
  participants: 'Beteiligte',
  decisionText: 'Entscheidung',
};

export const Decision = z.object({
  id: Id,
  title: z.string(),
  decisionText: z.string(),
  decidedAt: IsoDate.nullable(),
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  participants: z.array(z.string()),
  rationale: z.string().nullable(),
  consequences: z.string().nullable(),
  alternatives: z.array(z.string()),
  status: DecisionStatus,
  validFrom: IsoDate.nullable(),
  validUntil: IsoDate.nullable(),
  supersedesDecisionId: z.string().nullable(),
  sourceIds: z.array(z.string()),
  confidence: z.number(),
  missingFields: z.array(DecisionField),
  unknownFields: z.array(DecisionField),
  /** null for decisions captured before the origin was recorded */
  origin: DecisionOrigin.nullable(),
  /** Verbatim sentence of the source document that states the decision (only for decisions from documents). */
  evidence: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Decision = z.infer<typeof Decision>;

export const DecisionInput = z.object({
  title: z.string().optional(),
  decisionText: z.string().min(1),
  decidedAt: IsoDate.nullish(),
  topic: z.string().nullish(),
  project: z.string().nullish(),
  participants: z.array(z.string()).default([]),
  rationale: z.string().nullish(),
  consequences: z.string().nullish(),
  alternatives: z.array(z.string()).default([]),
  validFrom: IsoDate.nullish(),
  validUntil: IsoDate.nullish(),
  unknownFields: z.array(DecisionField).default([]),
  sourceIds: z.array(z.string()).default([]),
  confidence: Confidence.default(0.9),
  asDraft: z.boolean().default(false),
  origin: DecisionOrigin.optional(),
  evidence: z.string().nullish(),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

/**
 * Statuses an edit (`decisions:update`) may set. „Ersetzt“ and „Widerrufen“ are stage-2 actions that only happen
 * through the confirmed paths `decisions:supersede` / `decisions:revoke` (with undo entry).
 */
export const EditableDecisionStatus = z.enum(['draft', 'confirmed', 'active', 'unclear']);
export type EditableDecisionStatus = z.infer<typeof EditableDecisionStatus>;
export const isEditableDecisionStatus = (s: DecisionStatus): s is EditableDecisionStatus => EditableDecisionStatus.safeParse(s).success;

/** Partial update of a decision: only the given fields change (no defaults, see `patchSchema`). */
export const DecisionPatch = patchSchema(DecisionInput.omit({ origin: true, evidence: true })).extend({ status: EditableDecisionStatus.optional() });
export type DecisionPatch = z.infer<typeof DecisionPatch>;

// ---------- Open items ----------
export const OpenItemStatus = z.enum(['open', 'waiting', 'blocked', 'resolved', 'dismissed']);
export type OpenItemStatus = z.infer<typeof OpenItemStatus>;
export const Priority = z.enum(['low', 'normal', 'high']);

/** A claim of a solution proposal; `uncertain` if there is no valid source citation. */
const SolutionClaim = z.object({
  text: z.string(),
  detail: z.string().nullable().default(null),
  /** Source label like "S1" (see `sources`) */
  sourceRefs: z.array(z.string()).default([]),
  uncertain: z.boolean(),
});
/** Source that was (or would be) sent to the LLM for a solution proposal. */
export const SolutionSource = z.object({
  ref: z.string(),
  id: Id,
  type: EntityType,
  title: z.string(),
  /** false: only the title is sent (document excluded from the external analysis) */
  contentIncluded: z.boolean(),
  /** actually cited as evidence in the proposal */
  used: z.boolean().default(false),
});
export type SolutionSource = z.infer<typeof SolutionSource>;
/** Stored solution proposal for an open item (generating again replaces it). */
export const OpenItemSolution = z.object({
  generatedAt: IsoDate,
  model: z.string(),
  assessment: z.string(),
  assessmentSourceRefs: z.array(z.string()).default([]),
  assessmentUncertain: z.boolean(),
  nextSteps: z.array(SolutionClaim),
  openQuestions: z.array(z.string()),
  risks: z.array(SolutionClaim),
  uncertainties: z.array(z.string()),
  sources: z.array(SolutionSource),
  confidence: z.number(),
});
export type OpenItemSolution = z.infer<typeof OpenItemSolution>;

export const OpenItem = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  responsiblePersonId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  responsibleUnknown: z.boolean(),
  createdAt: IsoDate,
  dueAt: IsoDate.nullable(),
  dueUnknown: z.boolean(),
  status: OpenItemStatus,
  priority: Priority,
  sourceIds: z.array(z.string()),
  /** Conversation the item comes from (if a source is a chat message). */
  sourceConversationId: z.string().nullable().default(null),
  reminderAt: IsoDate.nullable(),
  confidence: z.number(),
  updatedAt: IsoDate,
  /** Most recently generated solution proposal (with date and model) */
  solution: OpenItemSolution.nullable().default(null),
  /** Discarded as a duplicate („verworfen (Duplikat)“, status `dismissed`): the open item it was merged into. */
  duplicateOfId: z.string().nullable().default(null),
  /** Comment given when closing (how it was solved / why it was dropped); null while open. */
  resolutionNote: z.string().nullable().default(null),
});
export type OpenItem = z.infer<typeof OpenItem>;

/** What would be sent to the LLM for a solution proposal – determined without an LLM call. */
export const SolutionPreview = z.object({
  mode: z.enum(['auto', 'confirm', 'local_only']),
  /** false: generation currently not possible (see blockedReason) */
  available: z.boolean(),
  blockedReason: z.string().nullable(),
  /** Details of the item that are sent */
  itemFields: z.array(z.object({ label: z.string(), value: z.string() })),
  sources: z.array(SolutionSource),
});
export type SolutionPreview = z.infer<typeof SolutionPreview>;
export const OpenItemInput = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  topic: z.string().nullish(),
  project: z.string().nullish(),
  responsible: z.string().nullish(),
  dueAt: IsoDate.nullish(),
  priority: Priority.default('normal'),
  sourceIds: z.array(z.string()).default([]),
  confidence: Confidence.default(0.9),
});
export type OpenItemInput = z.infer<typeof OpenItemInput>;

/** Statuses an edit (`openItems:update`) may set. „Erledigt“ and „Verworfen“ only via the confirmed `openItems:close` (with undo). */
export const EditableOpenItemStatus = z.enum(['open', 'waiting', 'blocked']);
export type EditableOpenItemStatus = z.infer<typeof EditableOpenItemStatus>;
export const isEditableOpenItemStatus = (s: OpenItemStatus): s is EditableOpenItemStatus => EditableOpenItemStatus.safeParse(s).success;

/** Partial update of an open item: only the given fields change (no defaults, see `patchSchema`). */
export const OpenItemPatch = patchSchema(OpenItemInput).extend({
  status: EditableOpenItemStatus.optional(),
  responsibleUnknown: z.boolean().optional(),
  dueUnknown: z.boolean().optional(),
});
export type OpenItemPatch = z.infer<typeof OpenItemPatch>;

// ---------- Events ----------
export const EventRecord = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  occurredAt: IsoDate,
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  sourceIds: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  /** Discarded as a duplicate („verworfen (Duplikat)“): the event it was merged into. */
  duplicateOfId: z.string().nullable(),
});
export type EventRecord = z.infer<typeof EventRecord>;
export const EventInput = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  occurredAt: IsoDate,
  topic: z.string().nullish(),
  project: z.string().nullish(),
  sourceIds: z.array(z.string()).default([]),
});
export type EventInput = z.infer<typeof EventInput>;

// ---------- Reminders, notifications, insights ----------
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
]);
export type InsightKind = z.infer<typeof InsightKind>;
/**
 * One answer option of a question insight (e.g. „Projekt“ / „Thema“ / „Beides ist richtig“). Choosing an option with an
 * `actionId` executes that agent action (with the user's confirmation) and accepts the insight; choosing an option
 * without an action („verschieden“, „keine davon“) rejects the insight, which is remembered permanently via its dedupe key.
 */
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

// ---------- Knowledge graph ----------
export const GraphEntity = z.object({
  id: Id,
  type: EntityType,
  name: z.string(),
  description: z.string().nullable(),
  /** Former names of entities merged into this one (resolve later mentions of these names). */
  aliases: z.array(z.string()),
  /** Roles of a person taken from mentions ("Chefin", "Führungskraft"); info only, not part of the name. */
  roles: z.array(z.string()),
  /** Discarded as a duplicate („verworfen (Duplikat)“, notes and events): the entity it was merged into. */
  duplicateOfId: z.string().nullable(),
  /** The user's own person (shown with the badge „Du“). */
  isSelf: z.boolean(),
  /** Lifecycle of a case („Vorgang“): open | closed. */
  status: z.string().nullish(),
  /** Topic/project taken from a document and not yet confirmed: never listed in LLM prompts (#199). */
  unconfirmed: z.boolean().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type GraphEntity = z.infer<typeof GraphEntity>;
export const GraphRelation = z.object({
  id: Id,
  sourceEntityId: Id,
  targetEntityId: Id,
  relationType: RelationType,
  confidence: z.number(),
  sourceIds: z.array(z.string()),
  status: RelationStatus,
  /** system = fixed methods, user, agent (#270); null for relations from before. */
  origin: z.string().nullish(),
  runId: z.string().nullish(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type GraphRelation = z.infer<typeof GraphRelation>;
export const EntityDetail = z.object({
  entity: GraphEntity,
  relations: z.array(
    GraphRelation.extend({
      direction: z.enum(['out', 'in']),
      other: GraphEntity,
    }),
  ),
});
export type EntityDetail = z.infer<typeof EntityDetail>;

// ---------- Search & timeline ----------
export const SearchResult = z.object({
  type: EntityType,
  id: Id,
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  path: z.string().nullable(),
  date: z.string().nullable(),
  matchedBy: z.array(z.enum(['keyword', 'semantic'])),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const TimelineEntry = z.object({
  id: z.string(),
  date: z.string(),
  year: z.number(),
  kind: z.enum(['document', 'decision', 'open_item', 'event', 'contradiction', 'note']),
  title: z.string(),
  description: z.string().nullable(),
  refs: z.array(EntityRef),
  /** no known date (an undated decision without dated source document): `date` is only the capture day (#168) */
  undated: z.boolean().optional(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

// ---------- Actions (agent proposals) ----------
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
  confirm_relation: z.object({ relationId: Id }),
  reject_relation: z.object({ relationId: Id }),
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

// ---------- Chat ----------
export const ChatContext = z.object({
  topics: z.array(EntityRef).default([]),
  projects: z.array(EntityRef).default([]),
  persons: z.array(EntityRef).default([]),
  decisions: z.array(EntityRef).default([]),
  openItems: z.array(EntityRef).default([]),
  documents: z.array(EntityRef).default([]),
  contradictions: z.array(EntityRef).default([]),
});
export type ChatContext = z.infer<typeof ChatContext>;

export const ChatMessage = z.object({
  id: Id,
  conversationId: Id,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: IsoDate,
  sources: z.array(SourceReference),
  context: ChatContext.nullable(),
  actions: z.array(StoredAgentAction),
  confidence: z.number().nullable(),
  uncertainties: z.array(z.string()),
  intent: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Answer buttons for a follow-up question (e.g. „Entscheidung“, „Notiz“); a click sends the text. */
  quickReplies: z.array(z.string()).default([]),
  /** Agent run that produced this answer (steps, changes, undo, tokens – #300). */
  runId: z.string().nullish(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ---------- Jobs, Audit, Scan ----------
export const JobStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;
export const Job = z.object({
  id: Id,
  type: z.string(),
  label: z.string(),
  status: JobStatus,
  progress: z.number().nullable(),
  progressMessage: z.string().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  /** Short outcome of a finished job for the job history (from a handler result with a `summary` string). */
  summary: z.string().nullable(),
  cancelRequested: z.boolean(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
});
export type Job = z.infer<typeof Job>;

export const AuditEntry = z.object({
  id: Id,
  at: IsoDate,
  action: z.string(),
  actor: z.enum(['user', 'agent']),
  trigger: z.string(),
  confirmed: z.boolean(),
  entityIds: z.array(z.string()),
  paths: z.array(z.string()),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  success: z.boolean(),
  error: z.string().nullable(),
  undoable: z.boolean(),
  undoneAt: IsoDate.nullable(),
  /** Agent run that made the change (#299). */
  runId: z.string().nullish(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const ScanRoot = z.object({
  id: Id,
  path: z.string(),
  enabled: z.boolean(),
  recursive: z.boolean(),
  excludedSubdirs: z.array(z.string()),
  extensions: z.array(z.string()),
  maxFileSizeMb: z.number(),
  llmAllowed: z.boolean(),
  lastScanAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type ScanRoot = z.infer<typeof ScanRoot>;

export const ScanFileStatus = z.enum(['new', 'changed', 'known', 'analyzed', 'archived', 'duplicate', 'excluded']);
export type ScanFileStatus = z.infer<typeof ScanFileStatus>;
export const ScanFile = z.object({
  id: Id,
  rootId: Id,
  path: z.string(),
  name: z.string(),
  ext: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  sha256: z.string().nullable(),
  mime: z.string(),
  status: ScanFileStatus,
  llmStatus: LlmStatus,
  documentId: z.string().nullable(),
  duplicateOfDocumentId: z.string().nullable(),
  firstSeenAt: IsoDate,
  lastSeenAt: IsoDate,
});
export type ScanFile = z.infer<typeof ScanFile>;

export const ScanSummary = z.object({
  rootId: Id,
  scanned: z.number(),
  newFiles: z.number(),
  changedFiles: z.number(),
  unchanged: z.number(),
  excluded: z.number(),
  skipped: z.number(),
  duplicates: z.number(),
  errors: z.array(z.string()),
  /** The per-root file limit stopped the walk; files beyond it were not checked (optional: older stored summaries lack it). */
  limitReached: z.boolean().optional(),
});
export type ScanSummary = z.infer<typeof ScanSummary>;

export const Category = z.object({ id: Id, path: z.string(), approved: z.boolean(), createdAt: IsoDate });
export type Category = z.infer<typeof Category>;

export const LlmTransmission = z.object({
  id: Id,
  at: IsoDate,
  purpose: z.string(),
  model: z.string(),
  endpoint: z.string(),
  bytes: z.number(),
  redactions: z.number(),
  documentIds: z.array(z.string()),
  preview: z.string(),
  success: z.boolean(),
  /** Tokens per request (agent requests, #302). */
  inputTokens: z.number().nullish(),
  outputTokens: z.number().nullish(),
  cacheReadTokens: z.number().nullish(),
});
export type LlmTransmission = z.infer<typeof LlmTransmission>;

export const BackupInfo = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['metadata', 'full']),
  createdAt: IsoDate,
  sizeBytes: z.number(),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

export const VerifyReport = z.object({
  checkedDocuments: z.number(),
  missingFiles: z.array(z.object({ documentId: Id, title: z.string(), path: z.string() })),
  changedFiles: z.array(z.object({ documentId: Id, title: z.string(), path: z.string() })),
  untrackedFiles: z.array(z.string()),
  ok: z.boolean(),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

// ---------- Archive root change ----------
/** `migrate`: copy the archive to the new folder, verify and switch; `pathOnly`: only switch (the files are already there). */
export const ArchiveRootChangeMode = z.enum(['migrate', 'pathOnly']);
export type ArchiveRootChangeMode = z.infer<typeof ArchiveRootChangeMode>;

/** Where the archived documents would be found under a (new) archive root. */
export const ArchiveRootPresence = z.object({
  /** Archived documents (status `archived` with an archive path). */
  documents: z.number(),
  /** Found at the same relative path with the expected size. */
  present: z.number(),
  /** No file at the expected path. */
  missing: z.number(),
  /** A file exists there but its size differs from the archived one. */
  different: z.number(),
  /** Titles of some missing or different documents (at most 5). */
  examples: z.array(z.string()),
});
export type ArchiveRootPresence = z.infer<typeof ArchiveRootPresence>;

export const ArchiveRootPreview = z.object({
  from: z.string(),
  to: z.string(),
  /** Presence of the archived documents in the new folder as it is now. */
  atTarget: ArchiveRootPresence,
  migrate: z.object({
    /** Files in the current archive folder that the move copies (or finds already present). */
    files: z.number(),
    bytes: z.number(),
    /** Files that already exist in the new folder with the same size (verified by checksum during the move). */
    alreadyPresent: z.number(),
    /** Reasons why moving the archive is not possible (empty = possible). */
    blockers: z.array(z.string()),
  }),
  /** Reasons why only changing the path is not possible (empty = possible). */
  pathOnlyBlockers: z.array(z.string()),
});
export type ArchiveRootPreview = z.infer<typeof ArchiveRootPreview>;

export const ArchiveRootStatus = z.object({
  root: z.string(),
  /** Presence of the archived documents under the current archive root. */
  current: ArchiveRootPresence,
  /** Most recent archive root change (if any). */
  lastChange: z
    .object({
      auditId: Id,
      at: IsoDate,
      from: z.string(),
      to: z.string(),
      mode: ArchiveRootChangeMode,
      undoable: z.boolean(),
    })
    .nullable(),
});
export type ArchiveRootStatus = z.infer<typeof ArchiveRootStatus>;

export const ArchiveRootChangeResult = z.object({
  mode: ArchiveRootChangeMode,
  /** Background job of a move (`migrate`), null for `pathOnly`. */
  jobId: Id.nullable(),
  /** Audit entry of a `pathOnly` change (undoable), null while a move is still running. */
  auditId: Id.nullable(),
  /** Archived documents that are not reachable under the new path (`pathOnly` only). */
  unreachable: z.number(),
});
export type ArchiveRootChangeResult = z.infer<typeof ArchiveRootChangeResult>;
