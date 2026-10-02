import { z } from 'zod';
import { AppErrorInfo, EntityType, Id, IsoDate, RelationMethod, RelationStatus, SourceReference, type Result } from './common';
import {
  AgentActionProposal,
  AgentActionStatus,
  ArchiveItemRequest,
  ArchivePlan,
  ArchiveResult,
  ArchiveRootChangeMode,
  ArchiveRootChangeResult,
  ArchiveRootPreview,
  ArchiveRootStatus,
  AppNotification,
  AuditEntry,
  BackupInfo,
  Category,
  ChatMessage,
  Contradiction,
  Decision,
  DecisionInput,
  DecisionPatch,
  DecisionStatus,
  DocumentRecord,
  DocumentStatus,
  EntityDetail,
  GraphEntity,
  GraphRelation,
  Insight,
  Job,
  LlmTransmission,
  EventInput,
  EventRecord,
  OpenItem,
  OpenItemInput,
  OpenItemPatch,
  OpenItemStatus,
  Reminder,
  ScanFile,
  ScanFileStatus,
  ScanRoot,
  ScanSummary,
  SearchResult,
  SolutionPreview,
  StoredAgentAction,
  TimelineEntry,
  VerifyReport,
} from './domain';
import { Settings, SettingsPatch } from './settings';
import {
  AgentCapability,
  AgentConversationState,
  AgentMode,
  AgentProgress,
  AgentRun,
  AgentRunStatus,
  AgentUsageSummary,
  MemoryEntry,
  MemoryInput,
} from './agent';

const Empty = z.object({});
const Ok = z.object({ ok: z.literal(true) });

export const AppStatus = z.object({
  version: z.string(),
  dataRoot: z.string(),
  archiveRoot: z.string(),
  platform: z.string(),
  setupCompleted: z.boolean(),
  llm: z.object({
    configured: z.boolean(),
    hasApiKey: z.boolean(),
    status: z.enum(['unknown', 'ok', 'error']),
    lastError: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
  }),
  secretStorage: z.object({ available: z.boolean(), backend: z.string() }),
  jobs: z.object({ pending: z.number(), running: z.number(), failed: z.number() }),
  unreadNotifications: z.number(),
  openInsights: z.number(),
  services: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'error']), detail: z.string().nullable() })),
});
export type AppStatus = z.infer<typeof AppStatus>;

export const KnowledgeCreateResult = z.object({ entity: GraphEntity, created: z.boolean() });
export type KnowledgeCreateResult = z.infer<typeof KnowledgeCreateResult>;

export const LlmTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  message: z.string(),
  modelReply: z.string().nullable(),
  error: AppErrorInfo.nullable(),
  /** Agent capability: adapter, native tool calling, streaming (#296, #297). */
  agent: AgentCapability.nullish(),
});
export type LlmTestResult = z.infer<typeof LlmTestResult>;

export const ChatSendResult = z.object({
  conversationId: Id,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
});
export type ChatSendResult = z.infer<typeof ChatSendResult>;

export const Conversation = z.object({ id: Id, title: z.string(), createdAt: IsoDate, updatedAt: IsoDate });
export type Conversation = z.infer<typeof Conversation>;

export const ScanProposalGroup = z.object({
  key: z.string(),
  label: z.string(),
  topic: z.string().nullable(),
  project: z.string().nullable(),
  documentIds: z.array(z.string()),
  confidence: z.number(),
});
export type ScanProposalGroup = z.infer<typeof ScanProposalGroup>;

export const ScanExclusion = z.object({ id: Id, kind: z.enum(['file', 'dir']), path: z.string(), createdAt: IsoDate });
export type ScanExclusion = z.infer<typeof ScanExclusion>;

export const TimelineQuery = z.object({
  topicId: z.string().optional(),
  projectId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** Maximum number of entries; the newest ones are returned (chronologically sorted). */
  limit: z.number().int().min(1).max(10000).default(300),
});

const Confirmed = z.literal(true).describe('Ausdrückliche Bestätigung des Benutzers (Pflicht)');

export const UndoRunResult = z.object({ undone: z.number().int(), failed: z.number().int(), conflicts: z.array(z.string()), message: z.string() });
export type UndoRunResult = z.infer<typeof UndoRunResult>;

/** A related entry – direct or over shared topics, projects, persons, tags, cases – with strength and reason (#276). */
const RelatedItem = z.object({
  entity: z.object({ id: z.string(), type: EntityType, name: z.string(), description: z.string().nullable() }),
  score: z.number(),
  reason: z.string(),
  relation: GraphRelation.nullable(),
  shared: z.array(z.object({ id: z.string(), type: EntityType, name: z.string() })),
});
export const RelatedPage = z.object({ total: z.number().int(), items: z.array(RelatedItem) });
export type RelatedPage = z.infer<typeof RelatedPage>;

/** An open link proposal with both ends, for the review list (#280). */
const LinkProposalEnd = z.object({ id: z.string(), type: EntityType, name: z.string() });
export const LinkProposalPage = z.object({
  total: z.number().int(),
  groups: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
  items: z.array(z.object({ relation: GraphRelation, source: LinkProposalEnd, target: LinkProposalEnd, groupKey: z.string() })),
});
export type LinkProposalPage = z.infer<typeof LinkProposalPage>;
const LinkGroupBy = z.enum(['method', 'entry']);

/** A threshold learned from the user's rejections (#275). */
const LearnedThreshold = z.object({
  method: RelationMethod,
  label: z.string(),
  measure: z.string(),
  offset: z.number(),
  cap: z.number(),
  confirmed: z.number().int(),
  rejected: z.number().int(),
});

/** How well the archive is linked (#292): current values, confirmation rate per method and the history. */
const LinkageSnapshot = z.object({
  at: IsoDate,
  entries: z.number().int(),
  orphans: z.number().int(),
  openProposals: z.number().int(),
  confirmationRate: z.number().nullable(),
});
export const LinkageMetrics = z.object({
  current: LinkageSnapshot,
  methods: z.array(
    z.object({ method: RelationMethod, label: z.string(), confirmed: z.number().int(), rejected: z.number().int(), open: z.number().int(), rate: z.number().nullable() }),
  ),
  history: z.array(LinkageSnapshot),
});
export type LinkageMetrics = z.infer<typeof LinkageMetrics>;

/** A link candidate of the fixed link methods with its reason (#271, #283, #313). */
export const LinkCandidate = z.object({
  id: z.string(),
  type: EntityType,
  name: z.string(),
  score: z.number(),
  method: z.enum(['similarity', 'mention']),
  reason: z.string(),
});
export type LinkCandidate = z.infer<typeof LinkCandidate>;

const NullableText = z.string().nullish();

const ch = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });

/**
 * Central, explicit IPC allowlist. Every channel has an input and an output schema.
 * Dynamic channel names are not allowed.
 */
export const ipcContract = {
  // --- App ---
  'app:getStatus': ch(Empty, AppStatus),
  'app:completeSetup': ch(Empty, Ok),
  'app:selectDirectory': ch(z.object({ title: z.string().optional() }), z.object({ path: z.string().nullable() })),
  'app:openPath': ch(z.object({ documentId: Id }), Ok),
  'app:revealPath': ch(z.object({ documentId: Id }), Ok),
  'app:openScanFile': ch(z.object({ scanFileId: Id }), Ok),

  // --- Settings ---
  'settings:get': ch(Empty, z.object({ settings: Settings, hasApiKey: z.boolean() })),
  'settings:update': ch(SettingsPatch, z.object({ settings: Settings })),
  'settings:setApiKey': ch(z.object({ apiKey: z.string().min(1).max(4096) }), Ok),
  'settings:clearApiKey': ch(Empty, Ok),

  // --- LLM ---
  'llm:testConnection': ch(
    z.object({
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    }),
    LlmTestResult,
  ),
  'llm:transmissions': ch(z.object({ limit: z.number().int().min(1).max(500).default(100) }), z.array(LlmTransmission)),

  // --- Chat ---
  'chat:send': ch(z.object({ conversationId: Id.optional(), text: z.string().min(1).max(20000) }), ChatSendResult),
  'chat:cancel': ch(z.object({ conversationId: Id.optional() }), z.object({ cancelled: z.number().int() })),
  'chat:history': ch(z.object({ conversationId: Id }), z.array(ChatMessage)),
  'chat:conversations': ch(Empty, z.array(Conversation)),
  'chat:newConversation': ch(Empty, Conversation),
  'chat:renameConversation': ch(z.object({ id: Id, title: z.string().trim().min(1).max(120) }), Conversation),

  // --- Agent mode (#294) ---
  'agent:capability': ch(Empty, AgentCapability.nullable()),
  'agent:runs': ch(
    z.object({
      trigger: z.enum(['chat', 'background']).optional(),
      status: AgentRunStatus.optional(),
      conversationId: Id.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    z.array(AgentRun),
  ),
  'agent:run': ch(z.object({ id: Id }), AgentRun),
  'agent:undoRun': ch(z.object({ runId: Id }), UndoRunResult),
  'agent:undoStep': ch(z.object({ runId: Id, stepId: z.string().min(1) }), UndoRunResult),
  'agent:cancelRun': ch(z.object({ runId: Id }), z.object({ cancelled: z.boolean() })),
  /** Mode of a conversation and the state of its running run (survives switching tabs, #300). */
  'agent:conversation': ch(z.object({ conversationId: Id.optional() }), AgentConversationState),
  'agent:setConversationMode': ch(z.object({ conversationId: Id, mode: AgentMode.nullable() }), AgentConversationState),
  'agent:active': ch(Empty, z.array(AgentProgress)),
  'agent:usage': ch(z.object({ days: z.number().int().min(1).max(366).default(31) }), AgentUsageSummary),
  'agent:runBackground': ch(z.object({ kind: z.enum(['inbox', 'archive_check', 'links']) }), z.object({ jobId: Id.nullable(), message: z.string() })),
  'agent:memory': ch(z.object({ kind: MemoryInput.shape.kind.optional() }), z.array(MemoryEntry)),
  'agent:saveMemory': ch(MemoryInput, MemoryEntry),
  'agent:updateMemory': ch(
    z.object({
      id: Id,
      name: z.string().trim().min(1).max(200).optional(),
      content: z.string().trim().min(1).max(4000).optional(),
      enabled: z.boolean().optional(),
      data: z.unknown().optional(),
    }),
    MemoryEntry,
  ),
  'agent:deleteMemory': ch(z.object({ id: Id }), Ok),
  /** Saves a file the agent produced (exports, reports) to a place the user picks. */
  'agent:saveFile': ch(z.object({ path: z.string().min(1) }), z.object({ savedTo: z.string().nullable() })),
  'agent:revealFile': ch(z.object({ path: z.string().min(1) }), Ok),

  // --- Agent actions ---
  'actions:list': ch(z.object({ status: AgentActionStatus.optional() }), z.array(StoredAgentAction)),
  'actions:resolve': ch(
    z.discriminatedUnion('decision', [
      z.object({
        decision: z.literal('approve'),
        actionId: Id,
        confirmed: Confirmed,
        strongConfirmed: z.boolean().default(false),
        parameterOverrides: z.record(z.string(), z.unknown()).optional(),
      }),
      z.object({ decision: z.literal('reject'), actionId: Id }),
    ]),
    StoredAgentAction,
  ),

  // --- Decisions ---
  'decisions:create': ch(DecisionInput, Decision),
  'decisions:update': ch(
    z.object({
      id: Id,
      patch: DecisionPatch,
    }),
    Decision,
  ),
  'decisions:get': ch(z.object({ id: Id }), Decision),
  'decisions:list': ch(z.object({ status: DecisionStatus.optional(), topicId: z.string().optional(), projectId: z.string().optional() }), z.array(Decision)),
  'decisions:search': ch(z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }), z.array(Decision)),
  'decisions:proposeSupersede': ch(z.object({ oldDecisionId: Id, newDecisionId: Id }), StoredAgentAction),
  /** Superseding is a stage-2 action: explicit confirmation required, with an undo entry. */
  'decisions:supersede': ch(z.object({ oldDecisionId: Id, newDecisionId: Id, confirmed: Confirmed }), z.object({ old: Decision, new: Decision })),
  /** Revoking is a stage-2 action: explicit confirmation required, with an undo entry. */
  'decisions:revoke': ch(z.object({ id: Id, confirmed: Confirmed }), Decision),

  // --- Documents ---
  'documents:import': ch(
    z.object({ paths: z.array(z.string().min(1)).min(1).max(200) }),
    z.object({
      imported: z.array(DocumentRecord),
      duplicates: z.array(z.object({ path: z.string(), existingDocumentId: Id })),
      rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
  ),
  'documents:list': ch(
    z.object({
      status: DocumentStatus.optional(),
      /** several statuses at once (e.g. everything the inbox shows) */
      statuses: z.array(DocumentStatus).min(1).optional(),
      ids: z.array(Id).min(1).max(1000).optional(),
      topicId: z.string().optional(),
      projectId: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(300),
    }),
    z.array(DocumentRecord),
  ),
  'documents:get': ch(z.object({ id: Id }), DocumentRecord),
  /** Number of documents per status (for badges, without loading the list). */
  'documents:counts': ch(z.object({}), z.record(z.string(), z.number())),
  /** Number of documents matching a list filter (without limit), so a capped list can say „N von M“. */
  'documents:count': ch(
    z.object({
      status: DocumentStatus.optional(),
      statuses: z.array(DocumentStatus).min(1).optional(),
      topicId: z.string().optional(),
      projectId: z.string().optional(),
      query: z.string().optional(),
    }),
    z.number(),
  ),
  'documents:classify': ch(z.object({ documentId: Id, allowLlm: z.boolean().default(true) }), z.object({ jobId: Id })),
  'documents:previewArchive': ch(z.object({ items: z.array(ArchiveItemRequest).min(1) }), ArchivePlan),
  'documents:archive': ch(
    z.object({
      items: z.array(ArchiveItemRequest).min(1),
      confirmed: Confirmed,
      /** Top-level categories whose creation the user explicitly confirms */
      approveNewCategories: z.array(z.string()).default([]),
      /** Confirmation for moving (the original is removed) */
      confirmMove: z.boolean().default(false),
    }),
    ArchiveResult,
  ),
  'documents:undoArchive': ch(z.object({ auditId: Id }), z.object({ undone: z.boolean(), message: z.string(), conflicts: z.array(z.string()) })),
  'documents:updateMetadata': ch(
    z.object({
      id: Id,
      title: z.string().optional(),
      topic: z.string().nullish(),
      project: z.string().nullish(),
      tags: z.array(z.string()).optional(),
      persons: z.array(z.string()).optional(),
      confirmed: Confirmed,
    }),
    DocumentRecord,
  ),
  'documents:ignore': ch(z.object({ id: Id }), DocumentRecord),
  /** Bulk assignment for a multi-selection (#291): ONE undo step. */
  'documents:bulkUpdate': ch(
    z.object({
      ids: z.array(Id).min(1).max(5000),
      topic: NullableText,
      project: NullableText,
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional(),
      addPersons: z.array(z.string()).optional(),
      removePersons: z.array(z.string()).optional(),
      docType: NullableText,
      documentDate: NullableText,
      confirmed: Confirmed,
    }),
    z.object({ updated: z.number().int(), auditId: z.string().nullable() }),
  ),
  /** Moves archived documents of a multi-selection into another folder (#304, same function as the agent). */
  'documents:relocate': ch(z.object({ ids: z.array(Id).min(1).max(5000), categoryPath: z.string().min(1), confirmed: Confirmed }), ArchiveResult),
  'documents:forTopic': ch(z.object({ topicId: Id }), z.array(DocumentRecord)),
  'documents:setLlmExcluded': ch(z.object({ id: Id, excluded: z.boolean() }), DocumentRecord),
  /** "Trotzdem importieren": takes a file out of quarantine into the inbox and starts the analysis */
  'documents:releaseQuarantine': ch(z.object({ id: Id, confirmed: Confirmed }), DocumentRecord),

  // --- Scanner ---
  'scanner:addDirectory': ch(z.object({ path: z.string().min(1), recursive: z.boolean().default(true) }), ScanRoot),
  'scanner:removeDirectory': ch(z.object({ id: Id }), Ok),
  'scanner:updateDirectory': ch(
    z.object({
      id: Id,
      enabled: z.boolean().optional(),
      recursive: z.boolean().optional(),
      excludedSubdirs: z.array(z.string()).optional(),
      extensions: z.array(z.string()).optional(),
      maxFileSizeMb: z.number().min(0.1).optional(),
      llmAllowed: z.boolean().optional(),
    }),
    ScanRoot,
  ),
  'scanner:listDirectories': ch(Empty, z.array(ScanRoot)),
  'scanner:start': ch(z.object({ rootId: Id.optional() }), z.object({ jobId: Id })),
  'scanner:getResults': ch(
    z.object({ rootId: Id.optional(), status: ScanFileStatus.optional(), limit: z.number().int().min(1).max(2000).default(500) }),
    z.object({ files: z.array(ScanFile), lastSummary: ScanSummary.nullable() }),
  ),
  'scanner:analyze': ch(z.object({ fileIds: z.array(Id).min(1).max(500), confirmLlm: z.boolean().default(false) }), z.object({ jobId: Id })),
  'scanner:proposals': ch(Empty, z.array(ScanProposalGroup)),
  'scanner:exclude': ch(z.object({ kind: z.enum(['file', 'dir']), path: z.string().min(1) }), ScanExclusion),
  'scanner:listExclusions': ch(Empty, z.array(ScanExclusion)),
  'scanner:removeExclusion': ch(z.object({ id: Id }), Ok),

  // --- Jobs ---
  'jobs:list': ch(z.object({ limit: z.number().int().min(1).max(500).default(100) }), z.array(Job)),
  'jobs:retry': ch(z.object({ id: Id }), Job),
  'jobs:cancel': ch(z.object({ id: Id }), Job),

  // --- Notifications ---
  'notifications:list': ch(
    z.object({ includeResolved: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }),
    z.array(AppNotification),
  ),
  'notifications:markRead': ch(z.object({ ids: z.array(Id).min(1) }), Ok),
  'notifications:resolve': ch(z.object({ id: Id }), AppNotification),
  'notifications:resolveAll': ch(Empty, z.object({ resolved: z.number().int() })),
  'notifications:snooze': ch(z.object({ id: Id, remindAt: IsoDate }), Reminder),

  // --- Insights / consistency / contradictions ---
  'insights:list': ch(z.object({ status: z.enum(['open', 'accepted', 'rejected', 'snoozed']).optional() }), z.array(Insight)),
  'insights:respond': ch(
    z.discriminatedUnion('response', [
      z.object({ response: z.literal('accept'), id: Id, confirmed: Confirmed, strongConfirmed: z.boolean().default(false) }),
      z.object({ response: z.literal('reject'), id: Id }),
      // answers a question insight with one of its `choices`; options with an action need the explicit confirmation
      z.object({ response: z.literal('choose'), id: Id, choiceId: z.string().min(1), confirmed: Confirmed, strongConfirmed: z.boolean().default(false) }),
      z.object({ response: z.literal('remind_later'), id: Id, remindAt: IsoDate }),
    ]),
    Insight,
  ),
  'consistency:run': ch(Empty, z.object({ jobId: Id })),
  'contradictions:list': ch(z.object({ status: z.enum(['detected', 'acknowledged', 'resolved', 'false_positive']).optional() }), z.array(Contradiction)),
  'contradictions:resolve': ch(
    z.object({
      id: Id,
      resolution: z.enum(['acknowledged', 'resolved', 'false_positive']),
      confirmed: Confirmed,
      supersedeOldDecisionId: Id.optional(),
      supersedeNewDecisionId: Id.optional(),
    }),
    Contradiction,
  ),

  // --- Reminders ---
  'reminders:create': ch(
    z.object({
      targetType: z.enum(['open_item', 'insight', 'notification', 'decision', 'document', 'custom']),
      targetId: z.string().nullable(),
      title: z.string().min(1),
      remindAt: IsoDate,
    }),
    Reminder,
  ),
  'reminders:snooze': ch(z.object({ id: Id, remindAt: IsoDate }), Reminder),
  'reminders:dismiss': ch(z.object({ id: Id }), Ok),
  'reminders:list': ch(z.object({ status: z.enum(['pending', 'fired', 'dismissed']).optional() }), z.array(Reminder)),

  // --- Open items ---
  'openItems:list': ch(
    z.object({ status: OpenItemStatus.optional(), topicId: z.string().optional(), projectId: z.string().optional(), onlyActive: z.boolean().default(false) }),
    z.array(OpenItem),
  ),
  'openItems:create': ch(OpenItemInput, OpenItem),
  'openItems:update': ch(
    z.object({
      id: Id,
      patch: OpenItemPatch,
    }),
    OpenItem,
  ),
  /** Closing is a stage-2 action: explicit confirmation required. */
  'openItems:close': ch(
    z.object({
      id: Id,
      status: z.enum(['resolved', 'dismissed']).default('resolved'),
      /** optional: how it was solved or why it was dropped */
      resolutionNote: z.string().max(4000).optional(),
      confirmed: Confirmed,
    }),
    OpenItem,
  ),
  /** What would be sent for a solution proposal (without an LLM call) – for the confirmation dialog. */
  'openItems:solutionPreview': ch(z.object({ id: Id }), SolutionPreview),
  /** Generates a solution proposal via the LLM; in mode „vorher fragen“ only with confirmation. */
  'openItems:generateSolution': ch(z.object({ id: Id, confirmed: z.boolean().default(false) }), OpenItem),
  /** Cancels a running generation (nothing is stored). */
  'openItems:cancelSolution': ch(z.object({ id: Id }), z.object({ cancelled: z.boolean() })),
  /** Applies the solution proposal: as an addition to the description, as new open items or as a note. */
  'openItems:applySolution': ch(
    z.discriminatedUnion('target', [
      z.object({ target: z.literal('description'), id: Id }),
      z.object({ target: z.literal('items'), id: Id, stepIndexes: z.array(z.number().int().min(0)).min(1), confirmed: Confirmed }),
      z.object({ target: z.literal('note'), id: Id }),
    ]),
    z.object({ item: OpenItem, created: z.array(OpenItem), noteId: z.string().nullable() }),
  ),

  // --- Knowledge graph ---
  'knowledge:listEntities': ch(
    z.object({ type: EntityType.optional(), query: z.string().optional(), limit: z.number().int().min(1).max(1000).default(300) }),
    z.array(GraphEntity.extend({ relationCount: z.number() })),
  ),
  'knowledge:getEntity': ch(z.object({ id: Id }), EntityDetail),
  'knowledge:resolveRelation': ch(z.object({ relationId: Id, status: RelationStatus, confirmed: Confirmed }), Ok),
  /**
   * Creates an entry from the knowledge page: topics/projects/persons as graph nodes, notes as indexed notes,
   * events as real dated records. `created: false` means an identical entry already existed and is returned instead.
   */
  'knowledge:createEntity': ch(
    z.discriminatedUnion('type', [
      z.object({ type: z.enum(['topic', 'project', 'person', 'note']), name: z.string().trim().min(1), description: z.string().optional() }),
      EventInput.extend({ type: z.literal('event') }),
    ]),
    KnowledgeCreateResult,
  ),
  /** Links two entries (same service function as the agent's link tool, #277); `confirmed` = the user's own link. */
  'knowledge:link': ch(
    z.object({
      sourceId: Id,
      targetId: Id,
      relationType: z.string().min(1),
      /** Set when the user takes over a proposal of a link method (#270): its method and evidence are kept. */
      method: RelationMethod.optional(),
      evidence: z.string().max(500).optional(),
      confirmed: Confirmed,
    }),
    GraphRelation,
  ),
  'knowledge:unlink': ch(z.object({ relationId: Id, confirmed: Confirmed }), Ok),
  /** Edits a note's title and/or text; it is analysed again afterwards (#273). Undoable. */
  'knowledge:updateNote': ch(z.object({ id: Id, title: z.string().max(200).nullish(), content: z.string().trim().min(1).max(100_000).nullish() }), GraphEntity),
  /** Related entries with the reason (#276, #289). */
  /** Related entries of an entry, strongest first, paged (#276). */
  'knowledge:related': ch(z.object({ id: Id, limit: z.number().int().min(1).max(50).default(10), offset: z.number().int().min(0).default(0) }), RelatedPage),
  /** Link proposals for an entry: similar entries and mentioned topics/projects (#283); the same function as the agent's suggest_links. */
  'links:suggestions': ch(z.object({ id: Id, limit: z.number().int().min(1).max(5).default(3) }), z.array(LinkCandidate)),
  /** Entries without any link (#290), paged with the total. */
  'links:unlinked': ch(
    z.object({ limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    z.object({ total: z.number().int(), items: z.array(z.object({ id: z.string(), type: EntityType, name: z.string(), createdAt: IsoDate })) }),
  ),
  /** Open link proposals, grouped by method or entry, paged with the total (#280). */
  'links:proposals': ch(
    z.object({ groupBy: LinkGroupBy.default('method'), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    LinkProposalPage,
  ),
  /** Confirms or rejects the given proposals – one undo step (#280). */
  'links:decide': ch(
    z.object({ relationIds: z.array(Id).min(1).max(500), decision: z.enum(['confirmed', 'rejected']), confirmed: Confirmed }),
    z.object({ decided: z.number().int() }),
  ),
  /** Confirms or rejects every open proposal of a group („Alle bestätigen“) – one undo step (#280). */
  'links:decideGroup': ch(
    z.object({ groupBy: LinkGroupBy, key: z.string().min(1), decision: z.enum(['confirmed', 'rejected']), confirmed: Confirmed }),
    z.object({ decided: z.number().int() }),
  ),
  /** Retroactive link run over the archive and topic proposals from groups (#279, #281) as a job; local, without LLM. */
  'links:startRun': ch(Empty, z.object({ jobId: Id })),
  /** What the link methods learned from rejections (#275): raise of the threshold per method, capped. */
  'links:thresholds': ch(Empty, z.array(LearnedThreshold)),
  /** Forgets the learned thresholds (#275); rejected pairs stay rejected. */
  'links:resetThresholds': ch(z.object({ confirmed: Confirmed }), z.object({ ok: z.literal(true) })),
  /** How well the archive is linked, with the history of the archive checks (#292). */
  'links:metrics': ch(Empty, LinkageMetrics),
  'knowledge:proposeMerge': ch(z.object({ sourceTopicId: Id, targetTopicId: Id }), StoredAgentAction),
  /** Accepts a topic/project taken from a document; only confirmed ones are listed in LLM prompts. */
  'knowledge:confirmEntity': ch(z.object({ id: Id }), GraphEntity),

  // --- Events ---
  'events:list': ch(z.object({ topicId: z.string().optional(), projectId: z.string().optional() }), z.array(EventRecord)),
  'events:create': ch(EventInput, EventRecord),
  'events:update': ch(z.object({ id: Id, patch: EventInput.partial() }), EventRecord),
  'events:delete': ch(z.object({ id: Id, confirmed: Confirmed }), Ok),

  // --- Timeline, search ---
  'timeline:get': ch(TimelineQuery, z.array(TimelineEntry)),
  'search:global': ch(
    z.object({ query: z.string().min(1).max(500), types: z.array(EntityType).optional(), limit: z.number().int().min(1).max(100).default(30) }),
    z.array(SearchResult),
  ),

  // --- Audit / Undo ---
  'audit:list': ch(z.object({ limit: z.number().int().min(1).max(1000).default(200), onlyUndoable: z.boolean().default(false) }), z.array(AuditEntry)),
  'audit:undo': ch(z.object({ auditId: Id }), z.object({ undone: z.boolean(), message: z.string(), conflicts: z.array(z.string()) })),

  // --- Categories, backup, archive check ---
  'categories:list': ch(Empty, z.array(Category)),
  'categories:create': ch(z.object({ path: z.string().min(1), confirmed: Confirmed }), Category),
  'backup:create': ch(z.object({ includeArchive: z.boolean().default(false) }), BackupInfo),
  'backup:list': ch(Empty, z.array(BackupInfo)),
  'archive:verify': ch(Empty, VerifyReport),
  'archive:rootStatus': ch(Empty, ArchiveRootStatus),
  'archive:previewRootChange': ch(z.object({ root: z.string().trim().min(1).max(4096) }), ArchiveRootPreview),
  'archive:changeRoot': ch(
    z.object({
      root: z.string().trim().min(1).max(4096),
      mode: ArchiveRootChangeMode,
      confirmed: Confirmed,
      /** `pathOnly`: switch even though archived documents are missing in the new folder (the user saw the warning). */
      acceptMissing: z.boolean().default(false),
    }),
    ArchiveRootChangeResult,
  ),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export const IPC_CHANNELS = Object.keys(ipcContract) as IpcChannel[];
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcParsedInput<C extends IpcChannel> = z.output<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.input<IpcContract[C]['output']>;

/** Events main → renderer (also an explicit allowlist). */
export const EVENT_CHANNELS = ['data:changed', 'job:updated', 'notification:new', 'status:changed', 'agent:progress'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];
export const DataChangedPayload = z.object({ scopes: z.array(z.string()) });
export type DataChangedPayload = z.infer<typeof DataChangedPayload>;

/** API that the preload bridge provides to the renderer as window.archivist. */
export interface ArchivistBridge {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<Result<IpcOutput<C>>>;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  /** Path of a file dropped via drag and drop (Electron webUtils). */
  getPathForFile(file: File): string;
}

export { AgentActionProposal, SourceReference };
