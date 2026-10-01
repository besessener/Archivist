import { z } from 'zod';
import { Confidence, EntityRef, EntityType, Id, IsoDate, RelationStatus, RelationType, SourceReference } from './common';

// ---------- Dokumente ----------
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

export const DocumentProposal = z.object({
  location: ArchiveLocationProposal,
  topic: z.string().nullable(),
  project: z.string().nullable(),
  persons: z.array(z.string()),
  tags: z.array(z.string()),
  possibleDecisions: z.array(z.object({ title: z.string(), decisionText: z.string(), decidedAt: z.string().nullish() })),
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
  confidence: z.number().nullable(),
  llmStatus: LlmStatus,
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

// ---------- Entscheidungen ----------
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
});
export type DecisionInput = z.infer<typeof DecisionInput>;

// ---------- Offene Punkte ----------
export const OpenItemStatus = z.enum(['open', 'waiting', 'blocked', 'resolved', 'dismissed']);
export type OpenItemStatus = z.infer<typeof OpenItemStatus>;
export const Priority = z.enum(['low', 'normal', 'high']);

/** Aussage eines Lösungsvorschlags; `uncertain`, wenn kein gültiger Quellenbeleg vorliegt. */
const SolutionClaim = z.object({
  text: z.string(),
  detail: z.string().nullable().default(null),
  /** Quellenkürzel wie „S1“ (siehe `sources`) */
  sourceRefs: z.array(z.string()).default([]),
  uncertain: z.boolean(),
});
/** Quelle, die für einen Lösungsvorschlag an das LLM gesendet wurde (bzw. würde). */
export const SolutionSource = z.object({
  ref: z.string(),
  id: Id,
  type: EntityType,
  title: z.string(),
  /** false: nur der Titel wird gesendet (Dokument von der externen Analyse ausgeschlossen) */
  contentIncluded: z.boolean(),
  /** im Vorschlag tatsächlich als Beleg genutzt */
  used: z.boolean().default(false),
});
export type SolutionSource = z.infer<typeof SolutionSource>;
/** Gespeicherter Lösungsvorschlag zu einem offenen Punkt (erneutes Generieren ersetzt ihn). */
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
  /** Unterhaltung, aus der der Punkt stammt (wenn eine Quelle eine Chat-Nachricht ist). */
  sourceConversationId: z.string().nullable().default(null),
  reminderAt: IsoDate.nullable(),
  confidence: z.number(),
  updatedAt: IsoDate,
  /** Zuletzt erzeugter Lösungsvorschlag (mit Datum und Modell) */
  solution: OpenItemSolution.nullable().default(null),
});
export type OpenItem = z.infer<typeof OpenItem>;

/** Was für einen Lösungsvorschlag an das LLM gesendet würde – ohne LLM-Aufruf ermittelt. */
export const SolutionPreview = z.object({
  mode: z.enum(['auto', 'confirm', 'local_only']),
  /** false: Erzeugung derzeit nicht möglich (siehe blockedReason) */
  available: z.boolean(),
  blockedReason: z.string().nullable(),
  /** Angaben des Punkts, die gesendet werden */
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

// ---------- Ereignisse ----------
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

// ---------- Erinnerungen, Benachrichtigungen, Insights ----------
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
  'orphan_document',
  'outdated_info',
  'missing_metadata',
  'external_file',
  'possibly_superseded',
  'misplaced_file',
  'scattered_documents',
  'low_confidence_relation',
]);
export type InsightKind = z.infer<typeof InsightKind>;
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

// ---------- Wissensgraph ----------
export const GraphEntity = z.object({
  id: Id,
  type: EntityType,
  name: z.string(),
  description: z.string().nullable(),
  /** Former names of entities merged into this one (resolve later mentions of these names). */
  aliases: z.array(z.string()),
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

// ---------- Suche & Timeline ----------
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
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

// ---------- Aktionen (Agentenvorschläge) ----------
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
  'confirm_relation',
  'reject_relation',
  'exclude_path',
  'create_category',
  'set_reminder',
  'create_open_item',
  'add_open_item_source',
  'record_decision',
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

export const StoredAgentAction = AgentActionProposal.extend({
  id: Id,
  conversationId: z.string().nullable(),
  label: z.string(),
  status: z.enum(['proposed', 'approved', 'rejected', 'executed', 'failed']),
  result: z.string().nullable(),
  createdAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
});
export type StoredAgentAction = z.infer<typeof StoredAgentAction>;

/** Parameter-Schemas je Aktionstyp (Laufzeitvalidierung vor der Ausführung). */
export const ActionParamSchemas = {
  archive_documents: z.object({
    items: z.array(ArchiveItemRequest).min(1),
    approveNewCategories: z.array(z.string()).default([]),
  }),
  /** Bereits archivierte Dokumente innerhalb des Archivs in einen anderen Ordner verschieben. */
  relocate_documents: z.object({
    items: z.array(z.object({ documentId: Id, categoryPath: z.string().min(1) })).min(1),
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
  close_open_item: z.object({ openItemId: Id, status: z.enum(['resolved', 'dismissed']).default('resolved') }),
  merge_topics: z.object({ sourceTopicId: Id, targetTopicId: Id }),
  /** Generic merge (topics, projects, persons, tags); `allowCrossType` merges a topic into a project or vice versa (target type wins). */
  merge_entities: z.object({ sourceIds: z.array(Id).min(1), targetId: Id, allowCrossType: z.boolean().default(false) }),
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
  /** Bestehenden offenen Punkt um ein weiteres Dokument als Quelle ergänzen (statt ihn doppelt anzulegen). */
  add_open_item_source: z.object({
    openItemId: Id,
    documentId: Id,
    description: z.string().nullish(),
    dueAt: z.string().nullish(),
    responsible: z.string().nullish(),
  }),
  record_decision: z.object({
    title: z.string(),
    decisionText: z.string(),
    decidedAt: z.string().nullish(),
    participants: z.array(z.string()).default([]),
    topic: z.string().nullish(),
    project: z.string().nullish(),
    sourceIds: z.array(z.string()).default([]),
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
  /** Antwortknöpfe für eine Rückfrage (z. B. „Entscheidung“, „Notiz“); ein Klick sendet den Text. */
  quickReplies: z.array(z.string()).default([]),
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
