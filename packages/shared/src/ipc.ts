import { z } from 'zod';
import { EntityType, Id, IsoDate, RelationMethod, RelationStatus, RelationType, type Result } from './common';
import { AgentActionStatus, AgentActionType, StoredAgentAction } from './actions';
import {
  ArchiveItemRequest,
  ArchivePlan,
  ArchiveResult,
  ArchiveRootChangeMode,
  ArchiveRootChangeResult,
  ArchiveRootPreview,
  ArchiveRootStatus,
  BackupInfo,
  Category,
  RelinkResult,
  VerifyReport,
} from './archive';
import { AuditEntry, LlmTransmission, UndoRunResult } from './audit';
import { ChatMessage, ChatSendResult, Conversation } from './chat';
import { Decision, DecisionInput, DecisionPatch, DecisionStatus } from './decisions';
import { DocumentRecord, DocumentStatus, TrashEntry } from './documents';
import { EventInput, EventRecord } from './events';
import { Job } from './jobs';
import { EntityDetail, GraphEntity, GraphRelation, KnowledgeCreateResult, SearchResult, TimelineEntry, TimelineQuery } from './knowledge';
import {
  CaseEntry,
  CaseSummary,
  EntrySubjects,
  LearnedThreshold,
  LinkCandidate,
  LinkGroupBy,
  LinkProposalPage,
  LinkageMetrics,
  NeighborhoodGraph,
  RelatedPage,
} from './links';
import { AppNotification, Contradiction, Insight, Reminder } from './notifications';
import { OpenItem, OpenItemInput, OpenItemPatch, OpenItemStatus, SolutionPreview } from './open-items';
import { ScanExclusion, ScanFile, ScanFileStatus, ScanProposalGroup, ScanRoot, ScanSummary } from './scan';
import { AppStatus, LlmTestResult } from './status';
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

const Confirmed = z.literal(true).describe('Ausdrückliche Bestätigung des Benutzers (Pflicht)');
const NullableText = z.string().nullish();

const channel = <Input extends z.ZodType, Output extends z.ZodType>(input: Input, output: Output) => ({ input, output });

/** The IPC allowlist: every channel has an input and an output schema; dynamic channel names are not allowed. */
export const ipcContract = {
  // --- App ---
  'app:getStatus': channel(Empty, AppStatus),
  'app:completeSetup': channel(Empty, Ok),
  'app:selectDirectory': channel(z.object({ title: z.string().optional() }), z.object({ path: z.string().nullable() })),
  'app:openPath': channel(z.object({ documentId: Id }), Ok),
  'app:revealPath': channel(z.object({ documentId: Id }), Ok),
  'app:openScanFile': channel(z.object({ scanFileId: Id }), Ok),

  // --- Settings ---
  'settings:get': channel(Empty, z.object({ settings: Settings, hasApiKey: z.boolean() })),
  'settings:update': channel(SettingsPatch, z.object({ settings: Settings })),
  'settings:setApiKey': channel(z.object({ apiKey: z.string().min(1).max(4096) }), Ok),
  'settings:clearApiKey': channel(Empty, Ok),

  // --- LLM ---
  'llm:testConnection': channel(
    z.object({
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    }),
    LlmTestResult,
  ),
  'llm:transmissions': channel(z.object({ limit: z.number().int().min(1).max(500).default(100) }), z.array(LlmTransmission)),

  // --- Chat ---
  'chat:send': channel(z.object({ conversationId: Id.optional(), text: z.string().min(1).max(20000) }), ChatSendResult),
  'chat:cancel': channel(z.object({ conversationId: Id.optional() }), z.object({ cancelled: z.number().int() })),
  'chat:history': channel(z.object({ conversationId: Id }), z.array(ChatMessage)),
  'chat:conversations': channel(Empty, z.array(Conversation)),
  'chat:newConversation': channel(Empty, Conversation),
  'chat:renameConversation': channel(z.object({ id: Id, title: z.string().trim().min(1).max(120) }), Conversation),

  // --- Agent mode (#294) ---
  'agent:capability': channel(Empty, AgentCapability.nullable()),
  'agent:runs': channel(
    z.object({
      trigger: z.enum(['chat', 'background']).optional(),
      status: AgentRunStatus.optional(),
      conversationId: Id.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    z.array(AgentRun),
  ),
  'agent:run': channel(z.object({ id: Id }), AgentRun),
  'agent:undoRun': channel(z.object({ runId: Id }), UndoRunResult),
  'agent:undoStep': channel(z.object({ runId: Id, stepId: z.string().min(1) }), UndoRunResult),
  'agent:cancelRun': channel(z.object({ runId: Id }), z.object({ cancelled: z.boolean() })),
  /** Mode of a conversation and the state of its running run (survives switching tabs, #300). */
  'agent:conversation': channel(z.object({ conversationId: Id.optional() }), AgentConversationState),
  'agent:setConversationMode': channel(z.object({ conversationId: Id, mode: AgentMode.nullable() }), AgentConversationState),
  'agent:active': channel(Empty, z.array(AgentProgress)),
  'agent:usage': channel(z.object({ days: z.number().int().min(1).max(366).default(31) }), AgentUsageSummary),
  'agent:runBackground': channel(z.object({ kind: z.enum(['inbox', 'archive_check', 'links']) }), z.object({ jobId: Id.nullable(), message: z.string() })),
  'agent:memory': channel(z.object({ kind: MemoryInput.shape.kind.optional() }), z.array(MemoryEntry)),
  'agent:saveMemory': channel(MemoryInput, MemoryEntry),
  'agent:updateMemory': channel(
    z.object({
      id: Id,
      name: z.string().trim().min(1).max(200).optional(),
      content: z.string().trim().min(1).max(4000).optional(),
      enabled: z.boolean().optional(),
      data: z.unknown().optional(),
    }),
    MemoryEntry,
  ),
  'agent:deleteMemory': channel(z.object({ id: Id }), Ok),
  /** Saves a file the agent produced (exports, reports) to a place the user picks. */
  'agent:saveFile': channel(z.object({ path: z.string().min(1) }), z.object({ savedTo: z.string().nullable() })),
  'agent:revealFile': channel(z.object({ path: z.string().min(1) }), Ok),

  // --- Agent actions ---
  'actions:list': channel(
    z.object({
      status: AgentActionStatus.optional(),
      actionType: AgentActionType.optional(),
      limit: z.number().int().min(1).max(200).default(200),
      offset: z.number().int().min(0).default(0),
    }),
    z.array(StoredAgentAction),
  ),
  'actions:get': channel(z.object({ id: Id }), StoredAgentAction),
  'actions:resolve': channel(
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
  'decisions:create': channel(DecisionInput, Decision),
  'decisions:update': channel(
    z.object({
      id: Id,
      patch: DecisionPatch,
    }),
    Decision,
  ),
  'decisions:get': channel(z.object({ id: Id }), Decision),
  'decisions:list': channel(
    z.object({ status: DecisionStatus.optional(), topicId: z.string().optional(), projectId: z.string().optional() }),
    z.array(Decision),
  ),
  'decisions:search': channel(z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }), z.array(Decision)),
  'decisions:proposeSupersede': channel(z.object({ oldDecisionId: Id, newDecisionId: Id }), StoredAgentAction),
  /** Superseding is a stage-2 action: explicit confirmation required, with an undo entry. */
  'decisions:supersede': channel(z.object({ oldDecisionId: Id, newDecisionId: Id, confirmed: Confirmed }), z.object({ old: Decision, new: Decision })),
  /** Revoking is a stage-2 action: explicit confirmation required, with an undo entry. */
  'decisions:revoke': channel(z.object({ id: Id, confirmed: Confirmed }), Decision),

  // --- Documents ---
  'documents:import': channel(
    z.object({ paths: z.array(z.string().min(1)).min(1).max(200) }),
    z.object({
      imported: z.array(DocumentRecord),
      duplicates: z.array(z.object({ path: z.string(), existingDocumentId: Id })),
      rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
  ),
  'documents:list': channel(
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
  'documents:get': channel(z.object({ id: Id }), DocumentRecord),
  /** Number of documents per status (for badges, without loading the list). */
  'documents:counts': channel(z.object({}), z.record(z.string(), z.number())),
  /** Number of documents matching a list filter (without limit), so a capped list can say „N von M“. */
  'documents:count': channel(
    z.object({
      status: DocumentStatus.optional(),
      statuses: z.array(DocumentStatus).min(1).optional(),
      topicId: z.string().optional(),
      projectId: z.string().optional(),
      query: z.string().optional(),
    }),
    z.number(),
  ),
  'documents:classify': channel(z.object({ documentId: Id, allowLlm: z.boolean().default(true) }), z.object({ jobId: Id })),
  'documents:previewArchive': channel(z.object({ items: z.array(ArchiveItemRequest).min(1) }), ArchivePlan),
  'documents:archive': channel(
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
  'documents:undoArchive': channel(z.object({ auditId: Id }), z.object({ undone: z.boolean(), message: z.string(), conflicts: z.array(z.string()) })),
  'documents:updateMetadata': channel(
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
  'documents:ignore': channel(z.object({ id: Id }), DocumentRecord),
  /** Bulk assignment for a multi-selection (#291): ONE undo step. */
  'documents:bulkUpdate': channel(
    z.object({
      ids: z.array(Id).min(1).max(5000),
      topic: NullableText,
      project: NullableText,
      /** Adds a topic/project (#287, #291): the main one where none is set, otherwise a further one. */
      addTopic: z.string().max(200).optional(),
      addProject: z.string().max(200).optional(),
      /** Puts the documents into this case (#286). */
      caseId: z.string().optional(),
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
  'documents:relocate': channel(z.object({ ids: z.array(Id).min(1).max(5000), categoryPath: z.string().min(1), confirmed: Confirmed }), ArchiveResult),
  /** New file names by a scheme like `{datum} {typ} {absender}`, with conflicts – nothing is renamed yet (#304). */
  'documents:previewRename': channel(
    z.object({ ids: z.array(Id).min(1).max(5000), pattern: z.string().trim().min(1).max(200) }),
    z.array(z.object({ documentId: Id, from: z.string().nullable(), to: z.string().nullable(), unchanged: z.boolean(), conflicts: z.array(z.string()) })),
  ),
  /** Renames archived files by the scheme; never overwrites, undoable (#304, same function as the agent). */
  'documents:rename': channel(z.object({ ids: z.array(Id).min(1).max(5000), pattern: z.string().trim().min(1).max(200), confirmed: Confirmed }), ArchiveResult),
  'documents:forTopic': channel(z.object({ topicId: Id }), z.array(DocumentRecord)),
  'documents:setLlmExcluded': channel(z.object({ id: Id, excluded: z.boolean() }), DocumentRecord),
  /** "Trotzdem importieren": takes a file out of quarantine into the inbox and starts the analysis */
  'documents:releaseQuarantine': channel(z.object({ id: Id, confirmed: Confirmed }), DocumentRecord),
  /** Deleting with a safety net: into the trash, restorable via `audit:undo` until the trash is emptied */
  'documents:trash': channel(z.object({ id: Id, confirmed: Confirmed }), z.object({ auditId: Id })),
  'trash:list': channel(z.object({}), z.array(TrashEntry)),
  /** Level 3: deleting for good needs the second, explicit confirmation */
  'trash:empty': channel(
    z.object({ confirmed: Confirmed, permanentlyConfirmed: Confirmed }),
    z.object({ deletedFiles: z.number().int().min(0), documents: z.number().int().min(0) }),
  ),

  // --- Scanner ---
  'scanner:addDirectory': channel(z.object({ path: z.string().min(1), recursive: z.boolean().default(true) }), ScanRoot),
  'scanner:removeDirectory': channel(z.object({ id: Id }), Ok),
  'scanner:updateDirectory': channel(
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
  'scanner:listDirectories': channel(Empty, z.array(ScanRoot)),
  'scanner:start': channel(z.object({ rootId: Id.optional() }), z.object({ jobId: Id })),
  'scanner:getResults': channel(
    z.object({ rootId: Id.optional(), status: ScanFileStatus.optional(), limit: z.number().int().min(1).max(2000).default(500) }),
    z.object({ files: z.array(ScanFile), lastSummary: ScanSummary.nullable() }),
  ),
  'scanner:analyze': channel(z.object({ fileIds: z.array(Id).min(1).max(500), confirmLlm: z.boolean().default(false) }), z.object({ jobId: Id })),
  'scanner:proposals': channel(Empty, z.array(ScanProposalGroup)),
  'scanner:exclude': channel(z.object({ kind: z.enum(['file', 'dir']), path: z.string().min(1) }), ScanExclusion),
  'scanner:listExclusions': channel(Empty, z.array(ScanExclusion)),
  'scanner:removeExclusion': channel(z.object({ id: Id }), Ok),

  // --- Jobs ---
  'jobs:list': channel(z.object({ limit: z.number().int().min(1).max(500).default(100) }), z.array(Job)),
  'jobs:retry': channel(z.object({ id: Id }), Job),
  'jobs:cancel': channel(z.object({ id: Id }), Job),

  // --- Notifications ---
  'notifications:list': channel(
    z.object({ includeResolved: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }),
    z.array(AppNotification),
  ),
  'notifications:markRead': channel(z.object({ ids: z.array(Id).min(1) }), Ok),
  'notifications:resolve': channel(z.object({ id: Id }), AppNotification),
  'notifications:resolveAll': channel(Empty, z.object({ resolved: z.number().int() })),
  'notifications:snooze': channel(z.object({ id: Id, remindAt: IsoDate }), Reminder),

  // --- Insights / consistency / contradictions ---
  'insights:list': channel(z.object({ status: z.enum(['open', 'accepted', 'rejected', 'snoozed']).optional() }), z.array(Insight)),
  'insights:respond': channel(
    z.discriminatedUnion('response', [
      z.object({ response: z.literal('accept'), id: Id, confirmed: Confirmed, strongConfirmed: z.boolean().default(false) }),
      z.object({ response: z.literal('reject'), id: Id }),
      // answers a question insight with one of its `choices`; options with an action need the explicit confirmation
      z.object({ response: z.literal('choose'), id: Id, choiceId: z.string().min(1), confirmed: Confirmed, strongConfirmed: z.boolean().default(false) }),
      z.object({ response: z.literal('remind_later'), id: Id, remindAt: IsoDate }),
    ]),
    Insight,
  ),
  'consistency:run': channel(Empty, z.object({ jobId: Id })),
  'contradictions:list': channel(z.object({ status: z.enum(['detected', 'acknowledged', 'resolved', 'false_positive']).optional() }), z.array(Contradiction)),
  'contradictions:resolve': channel(
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
  'reminders:create': channel(
    z.object({
      targetType: z.enum(['open_item', 'insight', 'notification', 'decision', 'document', 'custom']),
      targetId: z.string().nullable(),
      title: z.string().min(1),
      remindAt: IsoDate,
    }),
    Reminder,
  ),
  'reminders:snooze': channel(z.object({ id: Id, remindAt: IsoDate }), Reminder),
  'reminders:dismiss': channel(z.object({ id: Id }), Ok),
  'reminders:list': channel(z.object({ status: z.enum(['pending', 'fired', 'dismissed']).optional() }), z.array(Reminder)),

  // --- Open items ---
  'openItems:list': channel(
    z.object({ status: OpenItemStatus.optional(), topicId: z.string().optional(), projectId: z.string().optional(), onlyActive: z.boolean().default(false) }),
    z.array(OpenItem),
  ),
  'openItems:create': channel(OpenItemInput, OpenItem),
  'openItems:update': channel(
    z.object({
      id: Id,
      patch: OpenItemPatch,
    }),
    OpenItem,
  ),
  /** Closing is a stage-2 action: explicit confirmation required. */
  'openItems:close': channel(
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
  'openItems:solutionPreview': channel(z.object({ id: Id }), SolutionPreview),
  /** Generates a solution proposal via the LLM; in mode „vorher fragen“ only with confirmation. */
  'openItems:generateSolution': channel(z.object({ id: Id, confirmed: z.boolean().default(false) }), OpenItem),
  /** Cancels a running generation (nothing is stored). */
  'openItems:cancelSolution': channel(z.object({ id: Id }), z.object({ cancelled: z.boolean() })),
  /** Applies the solution proposal: as an addition to the description, as new open items or as a note. */
  'openItems:applySolution': channel(
    z.discriminatedUnion('target', [
      z.object({ target: z.literal('description'), id: Id }),
      z.object({ target: z.literal('items'), id: Id, stepIndexes: z.array(z.number().int().min(0)).min(1), confirmed: Confirmed }),
      z.object({ target: z.literal('note'), id: Id }),
    ]),
    z.object({ item: OpenItem, created: z.array(OpenItem), noteId: z.string().nullable() }),
  ),

  // --- Knowledge graph ---
  'knowledge:listEntities': channel(
    z.object({ type: EntityType.optional(), query: z.string().optional(), limit: z.number().int().min(1).max(1000).default(300) }),
    z.array(GraphEntity.extend({ relationCount: z.number() })),
  ),
  'knowledge:getEntity': channel(z.object({ id: Id }), EntityDetail),
  'knowledge:resolveRelation': channel(z.object({ relationId: Id, status: RelationStatus, confirmed: Confirmed }), Ok),
  /** Creates an entry from the knowledge page; `created: false` returns the identical entry that already existed. */
  'knowledge:createEntity': channel(
    z.discriminatedUnion('type', [
      z.object({ type: z.enum(['topic', 'project', 'case', 'person', 'note']), name: z.string().trim().min(1), description: z.string().optional() }),
      EventInput.extend({ type: z.literal('event') }),
    ]),
    KnowledgeCreateResult,
  ),
  /** Links two entries (same service function as the agent's link tool, #277); `confirmed` = the user's own link. */
  'knowledge:link': channel(
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
  'knowledge:unlink': channel(z.object({ relationId: Id, confirmed: Confirmed }), Ok),
  /** Edits a note's title and/or text; it is analysed again afterwards (#273). Undoable. */
  'knowledge:updateNote': channel(
    z.object({ id: Id, title: z.string().max(200).nullish(), content: z.string().trim().min(1).max(100_000).nullish() }),
    GraphEntity,
  ),
  /** Deletes a note after confirmation; undoable in the change log (#248). */
  'knowledge:deleteNote': channel(z.object({ id: Id, confirmed: Confirmed }), Ok),
  /** The surroundings of an entry as a graph, 1–2 steps, filtered; big hubs grouped (#288). */
  'knowledge:neighborhood': channel(
    z.object({
      id: Id,
      depth: z.number().int().min(1).max(2).default(1),
      relationTypes: z.array(RelationType).optional(),
      entityTypes: z.array(EntityType).optional(),
      statuses: z.array(z.enum(['proposed', 'confirmed'])).optional(),
      maxNodes: z.number().int().min(5).max(200).default(60),
    }),
    NeighborhoodGraph,
  ),
  /** Every confirmed „Unterthema von“ (child, parent) – the topic tree of the knowledge page (#282). */
  'knowledge:hierarchy': channel(Empty, z.array(z.object({ childId: z.string(), parentId: z.string() }))),
  /** Autocomplete after `[[` in a note (#285): entries by name or alias. */
  'knowledge:wikiSuggest': channel(
    z.object({ query: z.string().max(200), limit: z.number().int().min(1).max(20).default(8), excludeId: z.string().optional() }),
    z.array(z.object({ id: z.string(), type: EntityType, name: z.string(), alias: z.string().nullable() })),
  ),
  /** The target of each `[[Name]]` of a text – null for an unknown name (#285). */
  'knowledge:wikiResolve': channel(
    z.object({ names: z.array(z.string().max(200)).max(200), noteId: z.string().optional() }),
    z.array(z.object({ name: z.string(), entity: z.object({ id: z.string(), type: EntityType, name: z.string() }).nullable() })),
  ),
  /** Related entries of an entry with the reason, strongest first, paged (#276, #289). */
  'knowledge:related': channel(
    z.object({ id: Id, limit: z.number().int().min(1).max(50).default(10), offset: z.number().int().min(0).default(0) }),
    RelatedPage,
  ),
  /** Link proposals for an entry: similar entries and mentioned topics/projects (#283); the same function as the agent's suggest_links. */
  'links:suggestions': channel(z.object({ id: Id, limit: z.number().int().min(1).max(5).default(3) }), z.array(LinkCandidate)),
  /** Entries without any link (#290), paged with the total. */
  'links:unlinked': channel(
    z.object({ limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    z.object({ total: z.number().int(), items: z.array(z.object({ id: z.string(), type: EntityType, name: z.string(), createdAt: IsoDate })) }),
  ),
  /** Open link proposals, grouped by method or entry, paged with the total (#280). */
  'links:proposals': channel(
    z.object({ groupBy: LinkGroupBy.default('method'), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    LinkProposalPage,
  ),
  /** Confirms or rejects the given proposals – one undo step (#280). */
  'links:decide': channel(
    z.object({ relationIds: z.array(Id).min(1).max(500), decision: z.enum(['confirmed', 'rejected']), confirmed: Confirmed }),
    z.object({ decided: z.number().int() }),
  ),
  /** Confirms or rejects every open proposal of a group („Alle bestätigen“) – one undo step (#280). */
  'links:decideGroup': channel(
    z.object({ groupBy: LinkGroupBy, key: z.string().min(1), decision: z.enum(['confirmed', 'rejected']), confirmed: Confirmed }),
    z.object({ decided: z.number().int() }),
  ),
  /** Retroactive link run over the archive and topic proposals from groups (#279, #281) as a job; local, without LLM. */
  'links:startRun': channel(Empty, z.object({ jobId: Id })),
  /** What the link methods learned from rejections (#275): raise of the threshold per method, capped. */
  'links:thresholds': channel(Empty, z.array(LearnedThreshold)),
  /** Forgets the learned thresholds (#275); rejected pairs stay rejected. */
  'links:resetThresholds': channel(z.object({ confirmed: Confirmed }), z.object({ ok: z.literal(true) })),
  /** How well the archive is linked, with the history of the archive checks (#292). */
  'links:metrics': channel(Empty, LinkageMetrics),
  // --- Several topics/projects per entry (#287) and bulk assignment (#291) ---
  'subjects:of': channel(z.object({ ids: z.array(Id).min(1).max(1000) }), z.record(z.string(), EntrySubjects)),
  /** Sets the further topics/projects of an entry by name (the main one stays) – one undo step. */
  'subjects:setExtras': channel(
    z.object({ id: Id, topics: z.array(z.string().max(200)).max(50).optional(), projects: z.array(z.string().max(200)).max(50).optional() }),
    EntrySubjects,
  ),
  /** Bulk assignment of a list's selection: topic, project, tag, case – ONE undo step (#291). */
  'entries:bulkAssign': channel(
    z.object({
      ids: z.array(Id).min(1).max(500),
      topic: z.string().max(200).nullish(),
      project: z.string().max(200).nullish(),
      tag: z.string().max(100).nullish(),
      caseId: z.string().nullish(),
    }),
    z.object({ updated: z.number().int(), auditId: z.string().nullable() }),
  ),
  // --- Cases („Vorgänge“, #286) ---
  'cases:list': channel(z.object({ includeClosed: z.boolean().default(true) }), z.array(CaseSummary)),
  'cases:detail': channel(z.object({ id: Id }), z.object({ case: GraphEntity, entries: z.array(CaseEntry), openItems: z.array(CaseEntry) })),
  'cases:create': channel(
    z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(5000).nullish() }),
    z.object({ case: GraphEntity, created: z.boolean() }),
  ),
  /** Puts entries into a case – ONE undo step (#286, #291). */
  'cases:assign': channel(z.object({ entryIds: z.array(Id).min(1).max(500), caseId: Id }), z.object({ assigned: z.number().int() })),
  'cases:setStatus': channel(z.object({ id: Id, status: z.enum(['open', 'closed']) }), GraphEntity),
  'knowledge:proposeMerge': channel(z.object({ sourceTopicId: Id, targetTopicId: Id }), StoredAgentAction),
  /** Accepts a topic/project taken from a document; only confirmed ones are listed in LLM prompts. */
  'knowledge:confirmEntity': channel(z.object({ id: Id }), GraphEntity),

  // --- Events ---
  'events:list': channel(z.object({ topicId: z.string().optional(), projectId: z.string().optional() }), z.array(EventRecord)),
  'events:create': channel(EventInput, EventRecord),
  'events:update': channel(z.object({ id: Id, patch: EventInput.partial() }), EventRecord),
  'events:delete': channel(z.object({ id: Id, confirmed: Confirmed }), Ok),

  // --- Timeline, search ---
  'timeline:get': channel(TimelineQuery, z.array(TimelineEntry)),
  'search:global': channel(
    z.object({ query: z.string().min(1).max(500), types: z.array(EntityType).optional(), limit: z.number().int().min(1).max(100).default(30) }),
    z.array(SearchResult),
  ),

  // --- Audit / Undo ---
  'audit:list': channel(z.object({ limit: z.number().int().min(1).max(1000).default(200), onlyUndoable: z.boolean().default(false) }), z.array(AuditEntry)),
  'audit:undo': channel(z.object({ auditId: Id }), z.object({ undone: z.boolean(), message: z.string(), conflicts: z.array(z.string()) })),

  // --- Categories, backup, archive check ---
  'categories:list': channel(Empty, z.array(Category)),
  'categories:create': channel(z.object({ path: z.string().min(1), confirmed: Confirmed }), Category),
  'backup:create': channel(z.object({ includeArchive: z.boolean().default(false) }), BackupInfo),
  'backup:list': channel(Empty, z.array(BackupInfo)),
  'backup:restore': channel(z.object({ name: z.string().min(1).max(200), confirmed: Confirmed }), z.object({ restartRequired: z.literal(true) })),
  'archive:verify': channel(Empty, VerifyReport),
  'archive:relink': channel(z.object({ confirmed: Confirmed }), RelinkResult),
  'archive:rootStatus': channel(Empty, ArchiveRootStatus),
  'archive:previewRootChange': channel(z.object({ root: z.string().trim().min(1).max(4096) }), ArchiveRootPreview),
  'archive:changeRoot': channel(
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
