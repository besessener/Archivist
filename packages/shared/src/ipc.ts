import { z } from 'zod';
import { AppErrorInfo, EntityType, Id, IsoDate, RelationStatus, SourceReference, type Result } from './common';
import {
  AgentActionProposal,
  AgentActionStatus,
  ArchiveItemRequest,
  ArchivePlan,
  ArchiveResult,
  AppNotification,
  AuditEntry,
  BackupInfo,
  Category,
  ChatMessage,
  Contradiction,
  Decision,
  DecisionInput,
  DecisionStatus,
  DocumentRecord,
  DocumentStatus,
  EntityDetail,
  GraphEntity,
  Insight,
  Job,
  LlmTransmission,
  EventInput,
  EventRecord,
  OpenItem,
  OpenItemInput,
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
  limit: z.number().int().min(1).max(1000).default(300),
});

const Confirmed = z.literal(true).describe('Ausdrückliche Bestätigung des Benutzers (Pflicht)');

const ch = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });

/**
 * Zentrale, explizite IPC-Allowlist. Jeder Kanal hat Input- und Output-Schema.
 * Dynamische Kanalnamen sind nicht erlaubt.
 */
export const ipcContract = {
  // --- App ---
  'app:getStatus': ch(Empty, AppStatus),
  'app:completeSetup': ch(Empty, Ok),
  'app:selectDirectory': ch(z.object({ title: z.string().optional() }), z.object({ path: z.string().nullable() })),
  'app:openPath': ch(z.object({ documentId: Id }), Ok),
  'app:revealPath': ch(z.object({ documentId: Id }), Ok),
  'app:openScanFile': ch(z.object({ scanFileId: Id }), Ok),

  // --- Einstellungen ---
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
  'chat:history': ch(z.object({ conversationId: Id }), z.array(ChatMessage)),
  'chat:conversations': ch(Empty, z.array(Conversation)),
  'chat:newConversation': ch(Empty, Conversation),
  'chat:renameConversation': ch(z.object({ id: Id, title: z.string().trim().min(1).max(120) }), Conversation),

  // --- Agentenaktionen ---
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

  // --- Entscheidungen ---
  'decisions:create': ch(DecisionInput, Decision),
  'decisions:update': ch(
    z.object({
      id: Id,
      patch: DecisionInput.partial().extend({ status: DecisionStatus.optional() }),
    }),
    Decision,
  ),
  'decisions:get': ch(z.object({ id: Id }), Decision),
  'decisions:list': ch(z.object({ status: DecisionStatus.optional(), topicId: z.string().optional(), projectId: z.string().optional() }), z.array(Decision)),
  'decisions:search': ch(z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }), z.array(Decision)),
  'decisions:proposeSupersede': ch(z.object({ oldDecisionId: Id, newDecisionId: Id }), StoredAgentAction),

  // --- Dokumente ---
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
      topicId: z.string().optional(),
      projectId: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(300),
    }),
    z.array(DocumentRecord),
  ),
  'documents:get': ch(z.object({ id: Id }), DocumentRecord),
  'documents:classify': ch(z.object({ documentId: Id, allowLlm: z.boolean().default(true) }), z.object({ jobId: Id })),
  'documents:previewArchive': ch(z.object({ items: z.array(ArchiveItemRequest).min(1) }), ArchivePlan),
  'documents:archive': ch(
    z.object({
      items: z.array(ArchiveItemRequest).min(1),
      confirmed: Confirmed,
      /** Hauptkategorien, deren Neuanlage der Benutzer ausdrücklich bestätigt */
      approveNewCategories: z.array(z.string()).default([]),
      /** Bestätigung für Verschieben (Original wird entfernt) */
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
  'documents:forTopic': ch(z.object({ topicId: Id }), z.array(DocumentRecord)),
  'documents:setLlmExcluded': ch(z.object({ id: Id, excluded: z.boolean() }), DocumentRecord),
  /** "Trotzdem importieren": holt eine Datei aus der Quarantäne in den Eingang und stößt die Analyse an */
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

  // --- Benachrichtigungen ---
  'notifications:list': ch(
    z.object({ includeResolved: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }),
    z.array(AppNotification),
  ),
  'notifications:markRead': ch(z.object({ ids: z.array(Id).min(1) }), Ok),
  'notifications:resolve': ch(z.object({ id: Id }), AppNotification),
  'notifications:snooze': ch(z.object({ id: Id, remindAt: IsoDate }), Reminder),

  // --- Insights / Konsistenz / Widersprüche ---
  'insights:list': ch(z.object({ status: z.enum(['open', 'accepted', 'rejected', 'snoozed']).optional() }), z.array(Insight)),
  'insights:respond': ch(
    z.discriminatedUnion('response', [
      z.object({ response: z.literal('accept'), id: Id, confirmed: Confirmed, strongConfirmed: z.boolean().default(false) }),
      z.object({ response: z.literal('reject'), id: Id }),
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

  // --- Erinnerungen ---
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

  // --- Offene Punkte ---
  'openItems:list': ch(
    z.object({ status: OpenItemStatus.optional(), topicId: z.string().optional(), projectId: z.string().optional(), onlyActive: z.boolean().default(false) }),
    z.array(OpenItem),
  ),
  'openItems:create': ch(OpenItemInput, OpenItem),
  'openItems:update': ch(
    z.object({
      id: Id,
      patch: OpenItemInput.partial().extend({
        status: OpenItemStatus.optional(),
        responsibleUnknown: z.boolean().optional(),
        dueUnknown: z.boolean().optional(),
      }),
    }),
    OpenItem,
  ),
  /** Schließen ist eine Stufe-2-Aktion: ausdrückliche Bestätigung nötig. */
  'openItems:close': ch(z.object({ id: Id, status: z.enum(['resolved', 'dismissed']).default('resolved'), confirmed: Confirmed }), OpenItem),
  /** Was für einen Lösungsvorschlag gesendet würde (ohne LLM-Aufruf) – für den Bestätigungsdialog. */
  'openItems:solutionPreview': ch(z.object({ id: Id }), SolutionPreview),
  /** Erzeugt einen Lösungsvorschlag über das LLM; im Modus „vorher fragen“ nur mit Bestätigung. */
  'openItems:generateSolution': ch(z.object({ id: Id, confirmed: z.boolean().default(false) }), OpenItem),
  /** Bricht eine laufende Erzeugung ab (nichts wird gespeichert). */
  'openItems:cancelSolution': ch(z.object({ id: Id }), z.object({ cancelled: z.boolean() })),
  /** Übernimmt den Lösungsvorschlag: als Ergänzung der Beschreibung, als neue offene Punkte oder als Notiz. */
  'openItems:applySolution': ch(
    z.discriminatedUnion('target', [
      z.object({ target: z.literal('description'), id: Id }),
      z.object({ target: z.literal('items'), id: Id, stepIndexes: z.array(z.number().int().min(0)).min(1), confirmed: Confirmed }),
      z.object({ target: z.literal('note'), id: Id }),
    ]),
    z.object({ item: OpenItem, created: z.array(OpenItem), noteId: z.string().nullable() }),
  ),

  // --- Wissensgraph ---
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
  'knowledge:proposeMerge': ch(z.object({ sourceTopicId: Id, targetTopicId: Id }), StoredAgentAction),

  // --- Ereignisse ---
  'events:list': ch(z.object({ topicId: z.string().optional(), projectId: z.string().optional() }), z.array(EventRecord)),
  'events:create': ch(EventInput, EventRecord),
  'events:update': ch(z.object({ id: Id, patch: EventInput.partial() }), EventRecord),
  'events:delete': ch(z.object({ id: Id, confirmed: Confirmed }), Ok),

  // --- Timeline, Suche ---
  'timeline:get': ch(TimelineQuery, z.array(TimelineEntry)),
  'search:global': ch(
    z.object({ query: z.string().min(1).max(500), types: z.array(EntityType).optional(), limit: z.number().int().min(1).max(100).default(30) }),
    z.array(SearchResult),
  ),

  // --- Audit / Undo ---
  'audit:list': ch(z.object({ limit: z.number().int().min(1).max(1000).default(200), onlyUndoable: z.boolean().default(false) }), z.array(AuditEntry)),
  'audit:undo': ch(z.object({ auditId: Id }), z.object({ undone: z.boolean(), message: z.string(), conflicts: z.array(z.string()) })),

  // --- Kategorien, Backup, Archivprüfung ---
  'categories:list': ch(Empty, z.array(Category)),
  'categories:create': ch(z.object({ path: z.string().min(1), confirmed: Confirmed }), Category),
  'backup:create': ch(z.object({ includeArchive: z.boolean().default(false) }), BackupInfo),
  'backup:list': ch(Empty, z.array(BackupInfo)),
  'archive:verify': ch(Empty, VerifyReport),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export const IPC_CHANNELS = Object.keys(ipcContract) as IpcChannel[];
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcParsedInput<C extends IpcChannel> = z.output<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.input<IpcContract[C]['output']>;

/** Ereignisse Main → Renderer (ebenfalls explizite Allowlist). */
export const EVENT_CHANNELS = ['data:changed', 'job:updated', 'notification:new', 'status:changed'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];
export const DataChangedPayload = z.object({ scopes: z.array(z.string()) });
export type DataChangedPayload = z.infer<typeof DataChangedPayload>;

/** API, die die Preload-Bridge dem Renderer als window.archivist zur Verfügung stellt. */
export interface ArchivistBridge {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<Result<IpcOutput<C>>>;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  /** Pfad einer per Drag-and-Drop abgelegten Datei (Electron webUtils). */
  getPathForFile(file: File): string;
}

export { AgentActionProposal, SourceReference };
