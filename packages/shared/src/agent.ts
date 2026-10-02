import { z } from 'zod';
import { Id, IsoDate } from './common';

/**
 * Agent mode (Epic #294): Archivist works as an agent – it understands a request, fetches the data it needs with tools,
 * plans several steps and carries out changes. Everything below is shared between the main process and the renderer.
 */

/** „Auto“ carries out changes itself (logged, undoable); „Fragen“ prepares every change as a proposal. */
export const AgentMode = z.enum(['auto', 'ask']);
export type AgentMode = z.infer<typeof AgentMode>;

/** Which provider adapter talks to the model; `auto` derives it from the base URL. */
export const AgentAdapterChoice = z.enum(['auto', 'anthropic', 'openai']);
export type AgentAdapterChoice = z.infer<typeof AgentAdapterChoice>;
export const AgentAdapterId = z.enum(['anthropic', 'openai']);
export type AgentAdapterId = z.infer<typeof AgentAdapterId>;

/** Thinking depth. Claude: `output_config.effort`; OpenAI: `reasoning.effort` (xhigh/max are sent as high). */
export const AgentEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type AgentEffort = z.infer<typeof AgentEffort>;

/** Risk level of a tool: `read` changes nothing, `write` changes the archive (undoable), `critical` always asks. */
export const ToolRisk = z.enum(['read', 'write', 'critical']);
export type ToolRisk = z.infer<typeof ToolRisk>;

/** Technical limits of one run – protection against endless runs, not a cost budget (#302). */
export const AgentLimits = z.object({
  /** Emergency brake for the number of model rounds. */
  maxRounds: z.number().int().min(1).max(1000),
  /** Token budget per run (input + output, cache reads count a tenth). */
  maxTokens: z.number().int().min(5_000).max(50_000_000),
  /** Time limit per run. */
  timeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(24 * 3_600_000),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

/** Maintained price table (US$ per 1M tokens); only for information, never a limit. */
export const ModelPrice = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).default(0),
  cacheWrite: z.number().min(0).default(0),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const BackgroundAgentSettings = z.object({
  /** Sort new files of a scan or import into the archive (#313). */
  inbox: z.boolean().default(true),
  /** Agentic archive check: evaluate the findings and propose or carry out clean-ups. */
  archiveCheck: z.boolean().default(false),
  /** Link proposals for orphaned entries (only proposals, rule of Epic #269). */
  links: z.boolean().default(true),
  /** Nightly run (archive check and links) at this local hour; null = off. */
  nightlyHour: z.number().int().min(0).max(23).nullable().default(null),
  /** Deadline watcher: upcoming deadlines, overdue open items and reminders (#314). */
  deadlineWatch: z.boolean().default(true),
  /** How many days in advance the deadline watcher reports. */
  deadlineLeadDays: z.number().int().min(1).max(365).default(14),
  /** Weekly review in its own conversation (#314). */
  weeklyReview: z.boolean().default(true),
  /** 0 = Sunday … 6 = Saturday */
  weeklyReviewDay: z.number().int().min(0).max(6).default(1),
});
export type BackgroundAgentSettings = z.infer<typeof BackgroundAgentSettings>;

export const AgentSettings = z.object({
  /** Agent mode on. Without LLM or in mode „nur lokal“ the rule-based evaluation applies anyway. */
  enabled: z.boolean().default(true),
  mode: AgentMode.default('auto'),
  /** Mass actions above this many entries in one run always ask (#298). */
  massActionThreshold: z.number().int().min(1).max(100_000).default(100),
  adapter: AgentAdapterChoice.default('auto'),
  effort: AgentEffort.default('high'),
  chatLimits: AgentLimits.default({ maxRounds: 60, maxTokens: 1_500_000, timeoutMs: 15 * 60_000 }),
  backgroundLimits: AgentLimits.default({ maxRounds: 80, maxTokens: 2_000_000, timeoutMs: 45 * 60_000 }),
  /** Retries per model request after rate limits, server or network errors. */
  maxRetries: z.number().int().min(0).max(10).default(3),
  /** Own prices per model (key: model name), override the built-in table. */
  prices: z.record(z.string(), ModelPrice).default({}),
  background: BackgroundAgentSettings.default(() => BackgroundAgentSettings.parse({})),
  /** Learned rules, workflows and memory are given to every run (#315). */
  learning: z.boolean().default(true),
});
export type AgentSettings = z.infer<typeof AgentSettings>;

// ---------- Runs ----------
export const AgentRunStatus = z.enum(['running', 'done', 'ask_user', 'limit', 'cancelled', 'error', 'refusal']);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AgentUsage = z.object({
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  cacheReadTokens: z.number().int().default(0),
  cacheWriteTokens: z.number().int().default(0),
  requests: z.number().int().default(0),
  retries: z.number().int().default(0),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

export const AgentStepOutcome = z.enum(['running', 'ok', 'error', 'proposed', 'skipped', 'asked']);
export type AgentStepOutcome = z.infer<typeof AgentStepOutcome>;

/** One tool call of a run, in plain language with the technical details for the collapsible view. */
export const AgentStep = z.object({
  id: z.string(),
  round: z.number().int(),
  tool: z.string(),
  risk: ToolRisk,
  /** „Suche pptx-Dateien“ */
  label: z.string(),
  /** „14 gefunden“ */
  summary: z.string().default(''),
  outcome: AgentStepOutcome,
  args: z.unknown().optional(),
  /** Shortened result as it went to the model. */
  result: z.string().default(''),
  /** Audit entries of the changes this step made (undo per step). */
  auditIds: z.array(z.string()).default([]),
  /** Proposal card created instead of the change (mode „Fragen“ or critical). */
  actionId: z.string().nullable().default(null),
  startedAt: IsoDate,
  durationMs: z.number().nullable().default(null),
});
export type AgentStep = z.infer<typeof AgentStep>;

export const AgentRun = z.object({
  id: Id,
  conversationId: z.string().nullable(),
  /** chat | background:<kind> */
  trigger: z.string(),
  task: z.string(),
  provider: z.string(),
  model: z.string(),
  mode: AgentMode,
  status: AgentRunStatus,
  summary: z.string(),
  steps: z.array(AgentStep),
  usage: AgentUsage,
  /** Estimated cost in US$ (information only). */
  costUsd: z.number().nullable(),
  rounds: z.number().int(),
  /** Rules, workflows and memory entries that were applied (#315). */
  applied: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string() })).default([]),
  /** Files produced in this run (exports, reports). */
  files: z.array(z.string()).default([]),
  /** Number of changes that can still be undone. */
  undoable: z.number().int().default(0),
  error: z.string().nullable(),
  startedAt: IsoDate,
  finishedAt: IsoDate.nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

/** Live state of a running run (event `agent:progress`, and on request after switching tabs). */
export const AgentProgress = z.object({
  runId: Id,
  conversationId: z.string().nullable(),
  status: AgentRunStatus,
  round: z.number().int(),
  steps: z.array(AgentStep),
  /** Streamed answer text of the current round. */
  text: z.string(),
  usage: AgentUsage,
  costUsd: z.number().nullable(),
});
export type AgentProgress = z.infer<typeof AgentProgress>;

export const AgentUsageSummary = z.object({
  days: z.array(z.object({ day: z.string(), trigger: z.enum(['chat', 'background']), runs: z.number(), tokens: z.number(), costUsd: z.number() })),
  months: z.array(z.object({ month: z.string(), trigger: z.enum(['chat', 'background']), runs: z.number(), tokens: z.number(), costUsd: z.number() })),
  total: z.object({ runs: z.number(), tokens: z.number(), costUsd: z.number() }),
});
export type AgentUsageSummary = z.infer<typeof AgentUsageSummary>;

// ---------- Learning (#315) ----------
export const MemoryKind = z.enum(['rule', 'workflow', 'correction', 'preference', 'fact']);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Condition → action of a filing rule („Rechnungen von den Stadtwerken immer nach finanzen/energie“). */
export const RuleDefinition = z.object({
  when: z
    .object({
      sender: z.string().nullish(),
      docType: z.string().nullish(),
      nameContains: z.string().nullish(),
      ext: z.string().nullish(),
      topic: z.string().nullish(),
      textContains: z.string().nullish(),
    })
    .refine((w) => Object.values(w).some((v) => typeof v === 'string' && v.trim()), 'Eine Regel braucht mindestens eine Bedingung.'),
  then: z
    .object({
      folder: z.string().nullish(),
      topic: z.string().nullish(),
      project: z.string().nullish(),
      tags: z.array(z.string()).nullish(),
      renamePattern: z.string().nullish(),
    })
    .refine((t) => Object.values(t).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim())), 'Eine Regel braucht eine Aktion.'),
});
export type RuleDefinition = z.infer<typeof RuleDefinition>;

export const WorkflowDefinition = z.object({
  /** Steps in words („alle Belege des Vorjahres sammeln“, „auf Lücken prüfen“ …). */
  steps: z.array(z.string().min(1)).min(1).max(30),
  /** Optional parameters such as the year. */
  parameters: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
  /** Optional schedule as a background run (#313): weekday 0–6 or null. */
  scheduleWeekday: z.number().int().min(0).max(6).nullish(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const CorrectionDefinition = z.object({
  /** what the agent did */
  did: z.string(),
  /** what was right instead */
  instead: z.string(),
  /** grouping key for similar corrections (e.g. „folder:arztrechnung→gesundheit“) */
  key: z.string(),
});
export type CorrectionDefinition = z.infer<typeof CorrectionDefinition>;

export const MemoryEntry = z.object({
  id: Id,
  kind: MemoryKind,
  name: z.string(),
  content: z.string(),
  /** RuleDefinition, WorkflowDefinition or CorrectionDefinition, depending on the kind */
  data: z.unknown().nullable(),
  enabled: z.boolean(),
  /** user = explicit instruction, correction = learned from a correction, confirmed = proposal confirmed by the user */
  origin: z.enum(['user', 'correction', 'confirmed']),
  timesApplied: z.number().int(),
  lastAppliedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryInput = z.object({
  kind: MemoryKind,
  name: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  data: z.unknown().optional(),
  enabled: z.boolean().default(true),
});
export type MemoryInput = z.infer<typeof MemoryInput>;

/** Result of the agent-capable connection test (#296, #297). */
export const AgentCapability = z.object({
  adapter: AgentAdapterId,
  toolCalling: z.boolean(),
  streaming: z.boolean(),
  message: z.string(),
  /** Anthropic endpoint of the same resource, when tool calling does not work over the given one. */
  suggestedBaseUrl: z.string().nullable(),
  checkedAt: IsoDate,
});
export type AgentCapability = z.infer<typeof AgentCapability>;

export const AgentConversationState = z.object({
  mode: AgentMode,
  /** Mode set for this conversation only („frag mich diesmal vorher“); null = setting */
  override: AgentMode.nullable(),
  activeRun: AgentProgress.nullable(),
});
export type AgentConversationState = z.infer<typeof AgentConversationState>;
