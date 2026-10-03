import type { AgentCapability, AgentProgress, AgentRun, LlmTestResult, SourceReference } from '@archivist/shared';
import type { AppContext } from '../context';
import type { AppStateService } from '../services/app-state';
import type { LlmOverrides, LlmService } from '../services/llm';
import { askUserTool } from './ask-user';
import { BackgroundSchedule, type EnqueueBackground } from './background-schedule';
import { backgroundNotification, backgroundTask, type BackgroundKind } from './background-tasks';
import { executeProposalBatch, type BatchParams } from './batch';
import { AgentCapabilityService } from './capability';
import { modeOverrideIn, quickReplies, replyContent } from './chat-reply';
import { CorrectionLearner } from './corrections';
import { AgentShutdownError } from './file-jobs';
import { AgentHistoryStore } from './history-store';
import { pendingCalls, userTurn } from './history-window';
import { RefHumanizer } from './humanize';
import type { MemoryService } from './memory';
import { RefStore, ToolRegistry, type AgentChatState } from './registry';
import { AgentRunExecutor, type ExecutionResult } from './run-execution';
import { RunProgress } from './run-progress';
import type { RunOutcome } from './runner';
import type { AgentRunService, UndoRunResult } from './runs';
import { maskSecrets } from './security';
import type { ToolDeps } from './tools/common';
import { duplicateTools } from './tools/duplicates';
import { exportTools } from './tools/exports';
import { fileTools } from './tools/files';
import { knowledgeTools } from './tools/knowledge';
import { learningTools } from './tools/learning';
import { linkMethodTools } from './tools/link-methods';
import { linkTools } from './tools/links';
import { metadataTools } from './tools/metadata';
import { readTools } from './tools/read';
import { researchTools } from './tools/research';
import { registerSettingUndo, systemTools } from './tools/system';
import { registerToolUndo } from './tools/tool-undo';
import { undoPreviousRunTool } from './undo-run-tool';
import type { AgentMessage } from './types';
import type { PostToConversation } from './watcher';

export type { BackgroundKind } from './background-tasks';

export interface AgentChatReply {
  content: string;
  sources: SourceReference[];
  actionIds: string[];
  quickReplies: string[];
  runId: string;
  errorMessage: string | null;
  uncertainties: string[];
  state: AgentChatState;
  status: RunOutcome['status'];
}

interface ChatTurn {
  result: ExecutionResult;
  refs: RefStore;
  state: AgentChatState;
  override: AgentChatState['mode'];
  userText: string;
}

/** Requests per conversation run one after another (#251). */
const SERIAL = new Map<string, Promise<unknown>>();

const TAINTED_NOTE = 'Ein Dokument enthielt Anweisungen an den Agenten; sie wurden ignoriert.';

export interface AgentServiceDeps {
  ctx: AppContext;
  /** The services the agent's tools work with. */
  tools: ToolDeps;
  llm: LlmService;
  runs: AgentRunService;
  appState: AppStateService;
  memory: MemoryService;
}

/** Agent mode (Epic #294): chat and background runs with modes, exceptions, run log with undo, privacy filter and limits. */
export class AgentService {
  private readonly registry: ToolRegistry;
  private readonly progress: RunProgress;
  private readonly capabilities: AgentCapabilityService;
  private readonly schedule: BackgroundSchedule;
  private readonly history: AgentHistoryStore;
  private readonly executor: AgentRunExecutor;
  private readonly humanizer: RefHumanizer;
  private readonly corrections: CorrectionLearner;

  private readonly deps: ToolDeps;
  private readonly llm: LlmService;
  private readonly runs: AgentRunService;
  private readonly memory: MemoryService;

  constructor({ ctx, tools: deps, llm, runs, appState, memory }: AgentServiceDeps) {
    this.deps = deps;
    this.llm = llm;
    this.runs = runs;
    this.memory = memory;
    registerSettingUndo(deps);
    registerToolUndo(deps);
    const tools = [
      ...readTools(deps),
      ...knowledgeTools(deps),
      ...fileTools(deps),
      ...metadataTools(deps),
      ...linkTools(deps),
      ...linkMethodTools(deps),
      ...learningTools(deps),
      ...systemTools(deps),
      ...researchTools(deps),
      ...duplicateTools(deps),
      ...exportTools(deps),
      undoPreviousRunTool({ runs, undoRun: (runId) => this.undoRun(runId) }),
    ];
    const background = new ToolRegistry().register(...tools);
    this.registry = new ToolRegistry().register(...tools, askUserTool());
    this.progress = new RunProgress(ctx.events);
    this.capabilities = new AgentCapabilityService({ ctx, llm, appState, settings: deps.settings });
    this.schedule = new BackgroundSchedule({ ctx, tools: deps, appState, runs, memory, llm, isActive: () => this.isActive() });
    this.history = new AgentHistoryStore(ctx, deps);
    this.executor = new AgentRunExecutor({ ctx, tools: deps, llm, runs, memory, progress: this.progress, registries: { chat: this.registry, background } });
    this.humanizer = new RefHumanizer(deps);
    this.corrections = new CorrectionLearner({ memory, tools: deps });
    this.corrections.watchRelocations();
  }

  // ---------- schedules (#313, #314) ----------
  /** Starts the timers of the background work; `enqueue` puts a background run into the job queue. */
  start(options: { enqueue: EnqueueBackground; post: PostToConversation }): void {
    this.schedule.start(options);
  }

  stop(): void {
    this.schedule.stop();
    // a file job of a running run is not cancelled by quitting: it continues after the next start (#304)
    this.progress.abortAll(new AgentShutdownError());
  }

  scheduleInbox(delayMs?: number): void {
    this.schedule.scheduleInbox(delayMs);
  }

  inboxCandidates(): string[] {
    return this.schedule.inboxCandidates();
  }

  markInboxSeen(ids: string[]): void {
    this.schedule.markInboxSeen(ids);
  }

  // ---------- availability ----------
  capability(): AgentCapability | null {
    return this.capabilities.capability();
  }

  isActive(): boolean {
    return this.capabilities.isActive();
  }

  ensureCapable(): Promise<boolean> {
    return this.capabilities.ensureCapable();
  }

  testConnection(overrides: LlmOverrides = {}): Promise<LlmTestResult> {
    return this.capabilities.testConnection(overrides);
  }

  // ---------- history and progress ----------
  /** Agent messages after a sequence number (tests, debugging). */
  historyOf(conversationId: string, afterSeq = 0): AgentMessage[] {
    return this.history.after(conversationId, afterSeq);
  }

  progressFor(conversationId: string): AgentProgress | null {
    return this.progress.progressFor(conversationId);
  }

  activeRuns(): AgentProgress[] {
    return this.progress.activeRuns();
  }

  cancel(conversationId?: string): number {
    return this.progress.cancel(conversationId);
  }

  cancelRun(runId: string): boolean {
    return this.progress.cancelRun(runId);
  }

  // ---------- chat ----------
  /** Runs one message of a conversation through the agent. Requests of one conversation run one after another (#251). */
  chat(conversationId: string, message: { text: string; state: AgentChatState }): Promise<AgentChatReply> {
    const previous = SERIAL.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.chatNow(conversationId, message));
    SERIAL.set(conversationId, next);
    void next.finally(() => {
      if (SERIAL.get(conversationId) === next) SERIAL.delete(conversationId);
    });
    return next;
  }

  private async chatNow(conversationId: string, { text, state }: { text: string; state: AgentChatState }): Promise<AgentChatReply> {
    const override = modeOverrideIn(text) ?? state.mode ?? null;
    const refs = new RefStore(state.refs ?? { ids: {}, sets: {} });
    const history = this.history.replayable(conversationId, refs);
    const { text: masked, count: redactions } = maskSecrets(text);
    const turn = userTurn(pendingCalls(history), masked);
    const lastAnswer = turn.answersQuestion ? text : null;
    const userText = lastAnswer && state.task ? `${state.task}\n${text}` : text;
    const writer = this.history.turnWriter(conversationId, turn.messages);
    const result = await this.executor.execute({
      conversationId,
      trigger: 'chat',
      task: userText,
      mode: override ?? this.deps.settings.get().agent.mode,
      refs,
      history: [...history, ...turn.messages],
      persist: writer.persist,
      userText,
      lastAnswer,
      redactions,
    });
    writer.close(result.run.id);
    return this.reply({ result, refs, state, override, userText });
  }

  private reply({ result, refs, state, override, userText }: ChatTurn): AgentChatReply {
    const { outcome, ctx, run } = result;
    const human = this.humanizer.humanize(outcome.text, refs);
    const question = outcome.status === 'ask_user' && outcome.question ? this.humanizer.humanize(outcome.question.text, refs).text : '';
    return {
      content: replyContent({ outcome, text: human.text.trim(), question, changes: ctx.changes, announceAskMode: override === 'ask' && !state.mode }),
      sources: human.sources,
      actionIds: ctx.actionIds,
      quickReplies: quickReplies(outcome),
      runId: run.id,
      errorMessage: outcome.status === 'error' ? outcome.error : null,
      uncertainties: ctx.tainted ? [TAINTED_NOTE] : [],
      state: {
        refs: { ...refs.state, shared: [...new Set([...(refs.state.shared ?? []), ...ctx.shared])] },
        mode: override,
        task: outcome.status === 'ask_user' ? userText : null,
      },
      status: outcome.status,
    };
  }

  // ---------- background (#313) ----------
  /** Starts a background run; every trigger gets its own task, budget and emergency brake. Returns null if nothing to do. */
  async runBackground(
    kind: BackgroundKind,
    options: { docIds?: string[]; signal?: AbortSignal; report?: (progress: number, message: string) => void } = {},
  ): Promise<AgentRun | null> {
    if (!this.isActive() || !this.llm.canUseInBackground()) return null;
    if (!(await this.ensureCapable())) return null;
    const refs = new RefStore();
    // documents dealt with in an interrupted run are not paid for again
    const docIds = kind === 'inbox' ? (options.docIds ?? []).filter((id) => this.deps.docs.findRow(id)?.status === 'proposed') : [];
    const spec = backgroundTask(kind, { refs, docIds, findWorkflow: (id) => this.memory.list('workflow').find((e) => e.id === id && e.enabled) });
    if (!spec) return null;
    if (kind === 'inbox') this.markInboxSeen(docIds);
    const { outcome, ctx, run, proposals } = await this.executor.execute({
      conversationId: null,
      trigger: spec.trigger,
      task: spec.task,
      mode: this.deps.settings.get().agent.mode,
      refs,
      history: [{ role: 'user', content: spec.task }],
      persist: () => undefined,
      userText: '',
      lastAnswer: null,
      signal: options.signal,
      // the run is a job itself: longer steps report to it instead of starting jobs of their own (#304)
      job: { report: options.report ?? (() => undefined) },
    });
    // tool proposals (e.g. a new topic) count as well; with proposals, the first card is the run's own
    const waiting = proposals + ctx.actionIds.length - (proposals ? 1 : 0);
    if (!ctx.changes.length && !waiting && outcome.status !== 'error') return run;
    const summary = this.humanizer.humanize(outcome.text, refs).text;
    this.deps.notifications.create(
      backgroundNotification({ runId: run.id, status: outcome.status, error: outcome.error, changes: ctx.changes, waiting, summary }),
    );
    return run;
  }

  // ---------- proposals (#298) ----------
  /** Executes a confirmed proposal card of a run (all items or the selected ones) under the run's id. */
  executeBatch(params: BatchParams): Promise<string> {
    return executeProposalBatch({ registry: this.registry, runs: this.runs }, params);
  }

  // ---------- undo & corrections (#315) ----------
  async undoRun(runId: string): Promise<UndoRunResult> {
    const run = this.runs.get(runId);
    const result = await this.runs.undoRun(runId);
    if (result.undone) this.corrections.runUndone(run);
    return result;
  }

  async undoStep(runId: string, stepId: string): Promise<UndoRunResult> {
    const run = this.runs.get(runId);
    const result = await this.runs.undoStep(runId, stepId);
    if (result.undone) this.corrections.stepUndone(run, stepId);
    return result;
  }
}
