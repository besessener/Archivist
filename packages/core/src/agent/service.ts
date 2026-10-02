import type { ActionParamSchemas } from '@archivist/shared';
import {
  type AgentCapability,
  type AgentMode,
  type AgentProgress,
  type AgentRun,
  type AgentStep,
  type LlmTestResult,
  type RefType,
  type SourceReference,
  localToday,
} from '@archivist/shared';
import { z } from 'zod';
import type { AppContext } from '../context';
import type { LlmOverrides, LlmService } from '../services/llm';
import type { AppStateService } from '../services/app-state';
import { AppError, toErrorInfo } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { truncate } from '../util/text';
import { createAdapter, detectAdapter, anthropicEndpointFor, looksLikeClaude, type AdapterConfig } from './adapters';
import type { MemoryService } from './memory';
import { CORRECTIONS_FOR_RULE } from './memory';
import { costOf, emptyUsage } from './pricing';
import { systemPrompt, WEB_SEARCH_RULES, webSourcesMarkdown } from './prompt';
import { RefStore, ToolRegistry, defineTool, type AgentTool, type RefState, type ToolContext } from './registry';
import { ASK_USER, AgentRunner, AskUserArgs, type RunOutcome } from './runner';
import type { AgentRunService, UndoRunResult } from './runs';
import { agentRunScope } from './scope';
import { maskSecrets } from './security';
import { readTools } from './tools/read';
import { knowledgeTools } from './tools/knowledge';
import { fileTools } from './tools/files';
import { metadataTools } from './tools/metadata';
import { linkTools } from './tools/links';
import { learningTools } from './tools/learning';
import { registerSettingUndo, systemTools } from './tools/system';
import { researchTools } from './tools/research';
import { duplicateTools } from './tools/duplicates';
import { exportTools } from './tools/exports';
import { TYPE_LABEL, type ToolDeps } from './tools/common';
import type { AgentMessage, AgentToolCall, ProviderAdapter } from './types';
import { DeadlineWatcher, type PostToConversation } from './watcher';
import { agentMessages } from '../db/schema';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { ArchivistJson } from '../util/json';

/** Agent state of a conversation, stored with the conversation (refs survive follow-ups, the mode override too). */
export interface AgentChatState {
  refs?: RefState;
  /** Mode for this conversation only („frag mich diesmal vorher“); null = setting. */
  mode?: AgentMode | null;
  /** The request the agent asked a question about; it continues with the answer. */
  task?: string | null;
}

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

export type BackgroundKind = 'inbox' | 'archive_check' | 'links' | `workflow:${string}`;

/** Requests per conversation run one after another (#251). */
const SERIAL = new Map<string, Promise<unknown>>();

/** Upper bound for the history that goes to the model (characters of the serialized messages). */
const MAX_HISTORY_CHARS = 600_000;

const CAPABILITY_KEY = 'agent.capability';

const ASK_RE =
  /\b(?:frag(?:e)?\s+mich\s+(?:diesmal\s+|lieber\s+|bitte\s+)?(?:vorher|zuerst|erst)|vorher\s+fragen|erst\s+fragen|nur\s+vorschlagen|modus\s+„?fragen)/i;
const AUTO_RE = /\b(?:mach\s+(?:es\s+|das\s+)?einfach|ohne\s+(?:nach)?(?:zu)?fragen|frag\s+(?:mich\s+)?nicht|modus\s+„?auto)/i;

/** „Frag mich diesmal vorher“ / „mach einfach“ switch the mode for this conversation (#298). */
export function modeOverrideIn(text: string): AgentMode | null {
  if (ASK_RE.test(text)) return 'ask';
  if (AUTO_RE.test(text)) return 'auto';
  return null;
}

/** Unanswered tool calls of the last assistant message (e.g. a question to the user). */
export function pendingCalls(history: AgentMessage[]): AgentToolCall[] {
  const lastAssistant = history.findLastIndex((m) => m.role === 'assistant');
  if (lastAssistant === -1) return [];
  const a = history[lastAssistant] as Extract<AgentMessage, { role: 'assistant' }>;
  const answered = new Set(history.slice(lastAssistant + 1).flatMap((m) => (m.role === 'tool' ? m.results.map((r) => r.callId) : [])));
  return a.toolCalls.filter((c) => !answered.has(c.id));
}

/** The newest part of the history that fits; always starts with a user message (never in the middle of tool results). */
export function historyWindow(history: AgentMessage[], maxChars = MAX_HISTORY_CHARS): AgentMessage[] {
  let size = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    size += JSON.stringify(history[i]).length;
    if (size > maxChars) break;
    start = i;
  }
  while (start < history.length && history[start]!.role !== 'user') start += 1;
  if (start < history.length) return history.slice(start);
  // the current request alone is larger than the window: start at its user message anyway – tool results without the
  // calls they answer would be rejected by every provider
  const lastUser = history.findLastIndex((m) => m.role === 'user');
  return lastUser === -1 ? history.slice(-1) : history.slice(lastUser);
}

const TYPE_TO_REF: Partial<Record<string, RefType>> = { task: 'task', question: 'question' };

/**
 * Agent mode (Epic #294): runs the provider-neutral agent loop in the chat and in the background, with the mode
 * („Auto“/„Fragen“), the critical exceptions, the run log with undo, the privacy filter for every tool result, technical
 * limits and live progress. Without LLM, in mode „nur lokal“ or with an endpoint without tool calling the chat keeps
 * using the rule-based evaluation.
 */
export class AgentService {
  readonly registry: ToolRegistry;
  private readonly backgroundRegistry: ToolRegistry;
  private readonly active = new Map<string, AgentProgress>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly emitTimers = new Map<string, NodeJS.Timeout>();
  private probing: Promise<AgentCapability | null> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inboxTimer: NodeJS.Timeout | null = null;
  private watcher: DeadlineWatcher | null = null;
  /** Enqueues a background run as a job (set by the composition root). */
  private enqueue: ((kind: BackgroundKind, docIds: string[]) => void) | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: ToolDeps,
    private readonly llm: LlmService,
    private readonly runs: AgentRunService,
    private readonly appState: AppStateService,
    private readonly memory: MemoryService,
  ) {
    registerSettingUndo(deps);
    const tools = [
      ...readTools(deps),
      ...knowledgeTools(deps),
      ...fileTools(deps),
      ...metadataTools(deps),
      ...linkTools(deps),
      ...learningTools(deps),
      ...systemTools(deps),
      ...researchTools(deps),
      ...duplicateTools(deps),
      ...exportTools(deps),
      this.undoTool(),
    ];
    this.backgroundRegistry = new ToolRegistry().register(...tools);
    this.registry = new ToolRegistry().register(...tools, this.askTool());
    // the user moving a document the agent had filed is a correction (#315)
    deps.audit.onLog((e) => {
      if (e.action !== 'archive.relocate' || e.runId || e.success === false || e.trigger === 'agent' || !e.entityIds?.[0]) return;
      const docId = e.entityIds[0];
      if (!deps.audit.lastAgentChange(docId, 'archive.')) return;
      const from = (e.before as { categoryPath?: string | null } | null)?.categoryPath ?? '';
      const to = (e.after as { categoryPath?: string | null } | null)?.categoryPath ?? '';
      const row = deps.docs.findRow(docId);
      if (row && to && from !== to) this.noticeUserRelocation(docId, from, to, row.docType, row.ext);
    });
  }

  // ---------- schedules (#313, #314) ----------
  /** Starts the timers of the background work; `enqueue` puts a background run into the job queue. */
  start(opts: { enqueue: (kind: BackgroundKind, docIds: string[]) => void; post: PostToConversation }): void {
    this.enqueue = opts.enqueue;
    this.watcher = new DeadlineWatcher({
      settings: this.deps.settings,
      appState: this.appState,
      notifications: this.deps.notifications,
      runs: this.runs,
      tools: this.deps,
      post: opts.post,
    });
    this.runs.closeInterrupted();
    this.timer ??= setInterval(() => this.tick(), 10 * 60_000);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 30_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.timer = null;
    this.inboxTimer = null;
    for (const c of this.controllers.values()) c.abort();
  }

  /** Periodic check: deadline watcher, weekly review, nightly background runs. */
  tick(now = new Date()): void {
    try {
      this.watcher?.checkDeadlines(now);
      this.watcher?.weeklyReview(now);
      const bg = this.settings.agent.background;
      const today = localToday(now);
      if (bg.nightlyHour !== null && now.getHours() === bg.nightlyHour && this.appState.get('agent.nightly.lastDay') !== today && this.isActive()) {
        this.appState.set('agent.nightly.lastDay', today);
        if (bg.archiveCheck) this.enqueue?.('archive_check', []);
        if (bg.links) this.enqueue?.('links', []);
        const weekday = now.getDay();
        for (const wf of this.memory.list('workflow'))
          if (wf.enabled && (wf.data as { scheduleWeekday?: number | null } | null)?.scheduleWeekday === weekday) this.enqueue?.(`workflow:${wf.id}`, []);
      }
    } catch (err) {
      this.ctx.logger.warn('agent', 'Background tick failed', { error: err });
    }
  }

  /** New files were analyzed: a little later ONE inbox run sorts all of them (#313). */
  scheduleInbox(delayMs = 20_000): void {
    if (!this.settings.agent.background.inbox || !this.isActive() || !this.llm.canUseInBackground()) return;
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = null;
      const ids = this.inboxCandidates();
      if (ids.length) this.enqueue?.('inbox', ids);
    }, delayMs);
    this.inboxTimer.unref?.();
  }

  /** Analyzed inbox documents the background agent has not looked at yet (nothing is paid for twice after a restart). */
  inboxCandidates(): string[] {
    const seen = new Set<string>(this.seenInbox());
    return this.deps.docs
      .list({ statuses: ['proposed'], limit: 500 })
      .filter((d) => !seen.has(d.id))
      .map((d) => d.id);
  }

  private seenInbox(): string[] {
    try {
      return JSON.parse(this.appState.get('agent.inbox.seen') ?? '[]') as string[];
    } catch {
      return [];
    }
  }

  markInboxSeen(ids: string[]): void {
    this.appState.set('agent.inbox.seen', JSON.stringify([...new Set([...this.seenInbox(), ...ids])].slice(-5000)));
  }

  private get settings() {
    return this.deps.settings.get();
  }

  // ---------- availability ----------
  private capabilityKey(cfg: Pick<AdapterConfig, 'baseUrl' | 'model'>): string {
    return `${cfg.baseUrl}|${cfg.model}|${detectAdapter(cfg.baseUrl, this.settings.agent.adapter)}`;
  }

  /** Stored result of the tool-calling test for the configured endpoint, or null if it was never checked. */
  capability(): AgentCapability | null {
    const raw = this.appState.get(CAPABILITY_KEY);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as { key: string; cap: AgentCapability };
      const cfg = this.settings.llm;
      return stored.key === this.capabilityKey({ baseUrl: cfg.baseUrl.trim(), model: cfg.model.trim() }) ? stored.cap : null;
    } catch {
      return null;
    }
  }

  /** Agent mode is used: switched on, LLM usable (not „nur lokal“), endpoint not known to lack tool calling. */
  isActive(): boolean {
    return this.settings.agent.enabled && this.llm.canUse() && this.capability()?.toolCalling !== false;
  }

  /** Checks tool calling once per endpoint before the first run (one small request). */
  async ensureCapable(): Promise<boolean> {
    if (!this.isActive()) return false;
    if (this.capability()) return true;
    this.probing ??= (async () => {
      try {
        const cfg = this.llm.adapterConfig();
        const cap = await this.probe(createAdapter(detectAdapter(cfg.baseUrl, this.settings.agent.adapter), cfg), cfg);
        this.storeCapability(cfg, cap);
        return cap;
      } catch (err) {
        this.ctx.logger.warn('agent', 'Tool-calling probe failed', { error: err });
        return null;
      } finally {
        this.probing = null;
      }
    })();
    const cap = await this.probing;
    return Boolean(cap?.toolCalling);
  }

  private storeCapability(cfg: Pick<AdapterConfig, 'baseUrl' | 'model'>, cap: AgentCapability): void {
    this.appState.set(CAPABILITY_KEY, JSON.stringify({ key: this.capabilityKey(cfg), cap }));
    this.ctx.events.changed('settings', 'status');
  }

  /** Real tool call with result round trip and streaming (#296): the connection test of the agent. */
  private async probe(adapter: ProviderAdapter, cfg: Pick<AdapterConfig, 'baseUrl' | 'model'>): Promise<AgentCapability> {
    const tools = [
      {
        name: 'echo',
        description: 'Gibt einen Text zurück (Verbindungstest).',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ];
    const system =
      'Du bist ein Verbindungstest. Rufe das Werkzeug echo genau einmal mit text="archivist" auf. Nachdem du das Ergebnis erhalten hast, antworte mit dem Wort OK.';
    const history: AgentMessage[] = [{ role: 'user', content: 'Starte den Test.' }];
    const base = { system, tools, maxOutputTokens: 4_000, effort: 'low' as const, purpose: 'Verbindungstest (Werkzeuge)', documentIds: [] };
    const suggested = adapter.id === 'openai' && looksLikeClaude(cfg.model) ? anthropicEndpointFor(cfg.baseUrl) : null;
    const name = adapter.id === 'anthropic' ? 'Claude (Anthropic Messages API)' : 'OpenAI Responses API';
    const fail = (message: string): AgentCapability => ({
      adapter: adapter.id,
      toolCalling: false,
      streaming: false,
      message: suggested
        ? `${message} Für Claude-Modelle auf Microsoft Foundry bietet der Anthropic-Endpunkt derselben Ressource natives Tool-Calling: ${suggested}`
        : message,
      suggestedBaseUrl: suggested,
      checkedAt: nowIso(),
    });
    let first;
    try {
      first = await adapter.turn({ ...base, messages: history });
    } catch (err) {
      return fail(`Werkzeugaufrufe über ${name} schlugen fehl: ${toErrorInfo(err).message}`);
    }
    const call = first.toolCalls.find((c) => c.name === 'echo');
    if (!call) return fail(`Das Modell hat über ${name} kein Werkzeug aufgerufen – natives Tool-Calling wird über diesen Endpunkt offenbar nicht unterstützt.`);
    history.push({ role: 'assistant', text: first.text, toolCalls: first.toolCalls, provider: adapter.id, model: adapter.model, raw: first.raw });
    history.push({
      role: 'tool',
      results: first.toolCalls.map((c) => ({ callId: c.id, name: c.name, content: c.name === 'echo' ? 'archivist' : 'unbekannt', isError: c.name !== 'echo' })),
    });
    try {
      const second = await adapter.turn({ ...base, messages: history });
      return {
        adapter: adapter.id,
        toolCalling: true,
        streaming: first.streamed || second.streamed,
        message: `Agentenmodus bereit: ${name}, natives Tool-Calling${first.streamed || second.streamed ? ' und Streaming' : ''} funktionieren.`,
        suggestedBaseUrl: null,
        checkedAt: nowIso(),
      };
    } catch (err) {
      return fail(`Das Werkzeugergebnis konnte nicht zurückgegeben werden: ${toErrorInfo(err).message}`);
    }
  }

  /** Connection test of the setup dialog: text answer plus real tool calling (#296, #297). */
  async testConnection(overrides: LlmOverrides = {}): Promise<LlmTestResult> {
    const text = await this.llm.testConnection(overrides);
    if (!text.ok) return { ...text, agent: null };
    let cfg: AdapterConfig;
    try {
      cfg = this.llm.adapterConfig(overrides);
    } catch {
      return { ...text, agent: null };
    }
    const cap = await this.probe(createAdapter(detectAdapter(cfg.baseUrl, this.settings.agent.adapter), cfg), cfg);
    this.storeCapability(cfg, cap);
    return { ...text, agent: cap };
  }

  // ---------- history ----------
  private loadHistory(conversationId: string): AgentMessage[] {
    return this.ctx.database.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))
      .orderBy(asc(agentMessages.seq))
      .all()
      .map((r) => r.data as unknown as AgentMessage);
  }

  private appendHistory(conversationId: string, runId: string, message: AgentMessage): void {
    const db = this.ctx.database.db;
    const last = db
      .select({ seq: agentMessages.seq })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))
      .orderBy(asc(agentMessages.seq))
      .all()
      .at(-1);
    db.insert(agentMessages)
      .values({ id: newId(), conversationId, seq: (last?.seq ?? 0) + 1, runId, data: message as unknown as ArchivistJson, createdAt: nowIso() })
      .run();
  }

  /** Agent messages after a sequence number (tests, debugging). */
  historyOf(conversationId: string, afterSeq = 0): AgentMessage[] {
    return this.ctx.database.db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.conversationId, conversationId), gt(agentMessages.seq, afterSeq)))
      .orderBy(asc(agentMessages.seq))
      .all()
      .map((r) => r.data as unknown as AgentMessage);
  }

  // ---------- progress ----------
  private emit(progress: AgentProgress, now = false): void {
    const key = progress.runId;
    if (now) {
      clearTimeout(this.emitTimers.get(key));
      this.emitTimers.delete(key);
      this.ctx.events.emit('agent:progress', progress);
      return;
    }
    if (this.emitTimers.has(key)) return;
    this.emitTimers.set(
      key,
      setTimeout(() => {
        this.emitTimers.delete(key);
        this.ctx.events.emit('agent:progress', this.active.get(progress.conversationId ?? key) ?? progress);
      }, 120),
    );
  }

  /** Live state of the running run of a conversation (after switching tabs or reloading the UI, #300). */
  progressFor(conversationId: string): AgentProgress | null {
    return this.active.get(conversationId) ?? null;
  }

  activeRuns(): AgentProgress[] {
    return [...this.active.values()];
  }

  /** Stops the running run of a conversation (or all); what is done stays (#295). */
  cancel(conversationId?: string): number {
    let n = 0;
    for (const [key, p] of this.active) {
      if (conversationId && p.conversationId !== conversationId) continue;
      const c = this.controllers.get(p.runId);
      if (c && !c.signal.aborted) {
        c.abort();
        n += 1;
      }
      void key;
    }
    return n;
  }

  cancelRun(runId: string): boolean {
    const c = this.controllers.get(runId);
    if (!c || c.signal.aborted) return false;
    c.abort();
    return true;
  }

  // ---------- running ----------
  private context(background: boolean): string {
    const s = this.settings;
    const today = localToday();
    const weekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(new Date());
    return [
      `Heute ist ${weekday}, der ${today}.`,
      s.profile.name
        ? `Der Benutzer heißt ${s.profile.name}${s.profile.nicknames.length ? ` (auch: ${s.profile.nicknames.join(', ')})` : ''}; „ich/mir/mich“ meint ihn.`
        : null,
      `Datenschutzmodus: ${s.privacy.llmMode === 'auto' ? 'automatisch' : 'vorher fragen – nur ausdrücklich freigegebene Dokumentinhalte sind sichtbar'}.`,
      background ? null : 'Anliegen des Benutzers folgen.',
      !background && s.agent.webSearch ? WEB_SEARCH_RULES : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Web search runs in chat only; background runs never leave the archive (#301). */
  private webSearchFor(background: boolean): boolean {
    return !background && this.settings.agent.webSearch;
  }

  private learned(): { text: string; ids: Array<{ id: string; kind: string; label: string }> } {
    if (!this.settings.agent.learning) return { text: '', ids: [] };
    const { text, used } = this.memory.promptSection();
    return { text, ids: used.map((e) => ({ id: e.id, kind: e.kind, label: e.name })) };
  }

  private toolContext(o: Pick<ToolContext, 'runId' | 'conversationId' | 'trigger' | 'mode' | 'refs' | 'signal' | 'userText' | 'lastAnswer'>): ToolContext {
    return { ...o, shared: new Set(), files: [], applied: [], changes: [], actionIds: [], changedCount: 0, tainted: null };
  }

  private async execute(o: {
    conversationId: string | null;
    trigger: 'chat' | `background:${string}`;
    task: string;
    mode: AgentMode;
    refs: RefStore;
    history: AgentMessage[];
    persist: (runId: string, m: AgentMessage) => void;
    userText: string;
    lastAnswer: string | null;
    background: boolean;
    signal?: AbortSignal;
  }): Promise<{ outcome: RunOutcome; ctx: ToolContext; run: AgentRun; proposals: number }> {
    const s = this.settings.agent;
    const cfg = this.llm.adapterConfig();
    const adapter = createAdapter(detectAdapter(cfg.baseUrl, s.adapter), cfg);
    const runId = this.runs.start({
      conversationId: o.conversationId,
      trigger: o.trigger,
      task: truncate(o.task, 500),
      provider: adapter.id,
      model: adapter.model,
      mode: o.mode,
    });
    const controller = new AbortController();
    if (o.signal) o.signal.addEventListener('abort', () => controller.abort(), { once: true });
    this.controllers.set(runId, controller);
    const ctx = this.toolContext({
      runId,
      conversationId: o.conversationId,
      trigger: o.background ? 'background' : 'chat',
      mode: o.mode,
      refs: o.refs,
      signal: controller.signal,
      userText: o.userText,
      lastAnswer: o.lastAnswer,
    });
    const learned = this.learned();
    const progressKey = o.conversationId ?? runId;
    const progress: AgentProgress = {
      runId,
      conversationId: o.conversationId,
      status: 'running',
      round: 0,
      steps: [],
      text: '',
      usage: emptyUsage(),
      costUsd: null,
    };
    this.active.set(progressKey, progress);
    this.emit(progress, true);
    const proposals: Array<{ tool: string; args: unknown; label: string; risk: string; reason: string }> = [];
    const limits = o.background ? s.backgroundLimits : s.chatLimits;
    const runner = new AgentRunner({
      adapter,
      registry: o.background ? this.backgroundRegistry : this.registry,
      system: systemPrompt({
        mode: o.mode,
        massThreshold: s.massActionThreshold,
        learned: learned.text,
        background: o.background,
        context: this.context(o.background),
      }),
      history: historyWindow(o.history),
      onAppend: (m) => o.persist(runId, m),
      limits,
      maxRetries: s.maxRetries,
      retryDelayMs: this.llm.retryDelay,
      effort: s.effort,
      massThreshold: s.massActionThreshold,
      ctx,
      webSearch: this.webSearchFor(o.background),
      propose: (tool, args, label, reason) => {
        proposals.push({ tool: tool.name, args, label, risk: typeof tool.risk === 'function' ? tool.risk(args) : tool.risk, reason });
        return `NICHT AUSGEFÜHRT – als Vorschlag vorbereitet (${reason}). Der Benutzer bestätigt ihn in der Karte unter deiner Antwort; sag ihm das und arbeite mit dem Rest weiter.`;
      },
      onStep: (_step, all) => {
        progress.steps = all.map((x) => ({ ...x }));
        this.emit(progress);
      },
      onText: (delta, round) => {
        if (round !== progress.round) {
          progress.round = round;
          progress.text = '';
        }
        progress.text += delta;
        this.emit(progress);
      },
      onUsage: (usage) => {
        progress.usage = usage;
        progress.costUsd = costOf(usage, adapter.model, s.prices);
        this.emit(progress);
        this.runs.checkpoint(runId, progress.steps, usage);
      },
    });
    let outcome: RunOutcome;
    try {
      outcome = await runner.run();
    } finally {
      this.controllers.delete(runId);
      this.active.delete(progressKey);
    }
    let actionId: string | null = null;
    if (proposals.length) {
      const action = this.deps.actions.propose({
        actionType: 'agent_batch',
        label: proposals.length === 1 ? proposals[0]!.label : `${proposals.length} vorbereitete Änderungen ausführen`,
        rationale: [...new Set(proposals.map((p) => p.reason))].join(' '),
        confidence: 0.8,
        affectedEntities: [],
        requiredConfirmation: proposals.some((p) => (p.args as { action?: string } | null)?.action === 'delete') ? 'strong' : 'confirm',
        proposedParameters: { runId, conversationId: o.conversationId, items: proposals, refs: structuredClone(ctx.refs.state) },
        conversationId: o.conversationId,
      });
      actionId = action.id;
      for (const step of outcome.steps) if (step.outcome === 'proposed') step.actionId = action.id;
    }
    // learned entries the agent names with their id count as applied (#315)
    const mentioned = learned.ids.filter((l) => outcome.text.includes(l.id));
    for (const m of mentioned) if (!ctx.applied.some((a) => a.id === m.id)) ctx.applied.push(m);
    if (mentioned.length) this.memory.markApplied(mentioned.map((m) => m.id));
    const run = this.runs.finish(runId, {
      status: outcome.status,
      summary: outcome.text || outcome.error || '',
      steps: outcome.steps,
      usage: outcome.usage,
      costUsd: costOf(outcome.usage, adapter.model, s.prices),
      // a round is one model request (the last one usually has no tool call)
      rounds: Math.max(outcome.rounds, outcome.usage.requests),
      applied: ctx.applied,
      files: ctx.files,
      error: outcome.error,
    });
    progress.status = outcome.status;
    progress.steps = outcome.steps;
    this.emit(progress, true);
    // prompt caching: cache hits are logged with every run (#296)
    this.ctx.logger.info('agent', 'Agent run finished', {
      runId,
      trigger: o.trigger,
      provider: adapter.id,
      status: outcome.status,
      rounds: outcome.rounds,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheReadTokens: outcome.usage.cacheReadTokens,
      cacheWriteTokens: outcome.usage.cacheWriteTokens,
      retries: outcome.usage.retries,
    });
    if (actionId) ctx.actionIds.unshift(actionId);
    return { outcome, ctx, run, proposals: proposals.length };
  }

  /** Turns D/K references of the final answer into names the user understands; documents not shared stay anonymous. */
  humanize(text: string, refs: RefStore): { text: string; sources: SourceReference[] } {
    const sources = new Map<string, SourceReference>();
    const out = text.replace(/\b([DK])(\d{1,5})\b/g, (match) => {
      const id = refs.resolve(match);
      if (!id) return match;
      if (match.startsWith('D')) {
        const row = this.deps.docs.findRow(id);
        if (!row) return match;
        const d = this.deps.docs.get(id);
        if (!this.deps.privacy.mayShareDocument(d)) return 'ein Dokument';
        sources.set(id, {
          id,
          type: 'document',
          title: d.title,
          snippet: truncate(d.summary ?? d.textPreview, 200),
          path: d.archivePath ?? d.sourcePath,
          date: d.documentDate ?? d.archivedAt,
          score: 1,
        });
        return `„${d.title}“`;
      }
      const e = this.deps.graph.getEntity(id);
      if (!e) return match;
      const type = TYPE_TO_REF[e.type] ?? e.type;
      sources.set(id, { id, type, title: e.name, snippet: truncate(e.description ?? '', 200), path: null, date: e.createdAt, score: 1 });
      return `„${truncate(e.name, 80)}“`;
    });
    return { text: out, sources: [...sources.values()] };
  }

  /** Runs one message of a conversation through the agent. Requests of one conversation run one after another (#251). */
  chat(conversationId: string, text: string, state: AgentChatState): Promise<AgentChatReply> {
    const prev = SERIAL.get(conversationId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.chatNow(conversationId, text, state));
    SERIAL.set(conversationId, next);
    void next.finally(() => {
      if (SERIAL.get(conversationId) === next) SERIAL.delete(conversationId);
    });
    return next;
  }

  private async chatNow(conversationId: string, text: string, state: AgentChatState): Promise<AgentChatReply> {
    const override = modeOverrideIn(text) ?? state.mode ?? null;
    const mode = override ?? this.settings.agent.mode;
    const history = this.loadHistory(conversationId);
    const refs = new RefStore(state.refs ?? { ids: {}, sets: {} });
    const masked = maskSecrets(text).text;
    const pending = pendingCalls(history);
    let lastAnswer: string | null = null;
    const toAppend: AgentMessage[] = [];
    if (pending.length) {
      // the answer to the question becomes its tool result: the run continues with full context (#295)
      const asked = pending.some((c) => c.name === ASK_USER);
      toAppend.push({
        role: 'tool',
        results: pending.map((c) =>
          c.name === ASK_USER
            ? { callId: c.id, name: c.name, content: `Antwort des Benutzers: ${masked}`, isError: false }
            : { callId: c.id, name: c.name, content: 'Abgebrochen, bevor das Werkzeug lief.', isError: true },
        ),
      });
      if (asked) lastAnswer = text;
      else toAppend.push({ role: 'user', content: masked });
    } else toAppend.push({ role: 'user', content: masked });
    const userText = lastAnswer && state.task ? `${state.task}\n${text}` : text;
    let runIdForAppend: string | null = null;
    const deferred: AgentMessage[] = [...toAppend];
    const result = await this.execute({
      conversationId,
      trigger: 'chat',
      task: userText,
      mode,
      refs,
      history: [...history, ...toAppend],
      persist: (runId, m) => {
        if (!runIdForAppend) {
          runIdForAppend = runId;
          for (const d of deferred) this.appendHistory(conversationId, runId, d);
        }
        this.appendHistory(conversationId, runId, m);
      },
      userText,
      lastAnswer,
      background: false,
    });
    // a run that failed before its first request still keeps the user's message in the history
    if (!runIdForAppend) for (const d of deferred) this.appendHistory(conversationId, result.run.id, d);
    const { outcome, ctx, run } = result;
    const human = this.humanize(outcome.text, refs);
    const quick: string[] = [];
    let content = human.text.trim();
    if (outcome.status === 'ask_user' && outcome.question) {
      const q = this.humanize(outcome.question.text, refs).text;
      content = content ? `${content}\n\n${q}` : q;
      quick.push(...outcome.question.options);
    } else if (outcome.status === 'limit') quick.push('Weitermachen');
    else if (outcome.status === 'cancelled') {
      content = [content, ctx.changes.length ? `Abgebrochen. Bereits erledigt:\n${ctx.changes.map((c) => `• ${c}`).join('\n')}` : 'Abgebrochen.']
        .filter(Boolean)
        .join('\n\n');
    } else if (outcome.status === 'error') content = `${content ? `${content}\n\n` : ''}Das hat nicht geklappt: ${outcome.error ?? 'unbekannter Fehler'}`;
    else if (outcome.status === 'refusal') content = content || 'Das Modell hat diese Anfrage abgelehnt.';
    if (!content) content = ctx.changes.length ? `Erledigt:\n${ctx.changes.map((c) => `• ${c}`).join('\n')}` : 'Erledigt.';
    if (outcome.webSources.length) content = `${content}\n\n${webSourcesMarkdown(outcome.webSources)}`;
    if (override === 'ask' && mode === 'ask' && !state.mode) content = `_Für dieses Gespräch frage ich vor jeder Änderung._\n\n${content}`;
    return {
      content,
      sources: human.sources,
      actionIds: ctx.actionIds,
      quickReplies: quick,
      runId: run.id,
      errorMessage: outcome.status === 'error' ? outcome.error : null,
      uncertainties: ctx.tainted ? ['Ein Dokument enthielt Anweisungen an den Agenten; sie wurden ignoriert.'] : [],
      state: { refs: refs.state, mode: override, task: outcome.status === 'ask_user' ? userText : null },
      status: outcome.status,
    };
  }

  // ---------- background (#313) ----------
  private backgroundTask(kind: BackgroundKind, refs: RefStore, docIds: string[]): { task: string; trigger: `background:${string}` } | null {
    if (kind === 'inbox') {
      if (!docIds.length) return null;
      const set = refs.set(docIds);
      return {
        trigger: 'background:inbox',
        task: `Neue Dateien im Eingang: ${set} (${docIds.length} Dokument(e)). Sortiere sie ein: Prüfe zuerst gelernte Regeln (apply_rules mit preview), dann den Vorschlag der Analyse (document_details) und ähnliche frühere Ablagen (similar_filings). Archiviere eindeutige Fälle mit archive_inbox (mode copy) in den passenden Ordner und setze Thema/Projekt. Unsichere Fälle lässt du im Eingang (der Vorschlag der Analyse bleibt). Zum Schluss eine kurze Zusammenfassung.`,
      };
    }
    if (kind === 'archive_check')
      return {
        trigger: 'background:archive_check',
        task: 'Agentische Archivprüfung: Sieh dir die offenen Hinweise der Archivprüfung an (list_entries kind=insight) und das Archiv (archive_overview, problem_files, find_duplicates). Bewerte die Befunde. Räume auf, wo es eindeutig ist (z. B. falsch abgelegte Dateien verschieben, Duplikate als Duplikat markieren – nie löschen); alles andere lässt du als Hinweis stehen. Kurze Zusammenfassung am Ende.',
      };
    if (kind === 'links')
      return {
        trigger: 'background:links',
        task: 'Verknüpfungen pflegen: Suche archivierte Dokumente ohne Thema und Projekt (find_documents, dann related) und Einträge, die erkennbar zusammengehören (search, similar_filings). Schlage Verknüpfungen nur VOR (link mit onUserRequest=false) – bestätige nichts selbst. Vom Benutzer abgelehnte Paare schlägst du nie wieder vor. Kurze Zusammenfassung am Ende.',
      };
    const id = kind.slice('workflow:'.length);
    const wf = this.memory.list('workflow').find((e) => e.id === id && e.enabled);
    if (!wf) return null;
    const steps = (wf.data as { steps?: string[] } | null)?.steps ?? [];
    return {
      trigger: `background:workflow`,
      task: `Führe den Ablauf „${wf.name}“ [${wf.id}] aus: ${wf.content}\nSchritte: ${steps.map((st, i) => `${i + 1}. ${st}`).join(' ')}`,
    };
  }

  /** Starts a background run; every trigger gets its own task, budget and emergency brake. Returns null if nothing to do. */
  async runBackground(kind: BackgroundKind, opts: { docIds?: string[]; signal?: AbortSignal } = {}): Promise<AgentRun | null> {
    if (!this.isActive() || !this.llm.canUseInBackground()) return null;
    if (!(await this.ensureCapable())) return null;
    const refs = new RefStore();
    // documents dealt with in an interrupted run are not paid for again
    const docIds = kind === 'inbox' ? (opts.docIds ?? []).filter((id) => this.deps.docs.findRow(id)?.status === 'proposed') : [];
    const spec = this.backgroundTask(kind, refs, docIds);
    if (!spec) return null;
    if (kind === 'inbox') this.markInboxSeen(docIds);
    const history: AgentMessage[] = [{ role: 'user', content: spec.task }];
    const { outcome, ctx, run, proposals } = await this.execute({
      conversationId: null,
      trigger: spec.trigger,
      task: spec.task,
      mode: this.settings.agent.mode,
      refs,
      history,
      persist: () => undefined,
      userText: '',
      lastAnswer: null,
      background: true,
      signal: opts.signal,
    });
    // ONE bundled notification per run with summary and undo (#313)
    if (ctx.changes.length || proposals || outcome.status === 'error')
      this.deps.notifications.create({
        title: outcome.status === 'error' ? 'Hintergrund-Agent: Fehler' : 'Archivist hat im Hintergrund gearbeitet',
        description: [
          ctx.changes.length ? `${ctx.changes.length} Änderung(en): ${ctx.changes.slice(0, 5).join('; ')}${ctx.changes.length > 5 ? ' …' : ''}` : null,
          proposals ? `${proposals} Vorschlag/Vorschläge warten auf deine Bestätigung.` : null,
          outcome.status === 'error' ? outcome.error : null,
          truncate(this.humanize(outcome.text, refs).text.replace(/\s+/g, ' '), 300),
        ]
          .filter(Boolean)
          .join(' '),
        type: 'agent_run',
        priority: proposals ? 'normal' : 'low',
        proposedActions: [{ label: 'Lauf ansehen', kind: 'navigate', target: `/settings/?tab=agent&run=${run.id}` }],
        dedupeKey: `agent-run:${run.id}`,
      });
    return run;
  }

  // ---------- proposals (#298) ----------
  /** Executes a confirmed proposal card of a run (all items or the selected ones) under the run's id. */
  async executeBatch(params: z.output<(typeof ActionParamSchemas)['agent_batch']>): Promise<string> {
    const selected = params.selected?.length ? params.selected : params.items.map((_, i) => i);
    const refs = new RefStore(structuredClone(params.refs));
    // confirming the card IS the user's instruction (also for learning: „ja, merk dir das“)
    const ctx = this.toolContext({
      runId: params.runId,
      conversationId: params.conversationId ?? null,
      trigger: 'chat',
      mode: 'auto',
      refs,
      signal: new AbortController().signal,
      userText: 'Vom Benutzer bestätigt: ausführen und merken.',
      lastAnswer: 'ja',
    });
    const steps: AgentStep[] = [];
    const lines: string[] = [];
    for (const i of selected) {
      const item = params.items[i];
      if (!item) continue;
      const tool = this.registry.get(item.tool);
      const step: AgentStep = {
        id: newId(),
        round: 0,
        tool: item.tool,
        risk: item.risk,
        label: item.label,
        summary: '',
        outcome: 'running',
        args: item.args,
        result: '',
        auditIds: [],
        actionId: null,
        startedAt: nowIso(),
        durationMs: null,
      };
      steps.push(step);
      if (!tool) {
        step.outcome = 'error';
        lines.push(`${item.label}: unbekanntes Werkzeug`);
        continue;
      }
      const parsed = tool.schema.safeParse(item.args);
      if (!parsed.success) {
        step.outcome = 'error';
        lines.push(`${item.label}: ungültige Angaben`);
        continue;
      }
      const t0 = Date.now();
      try {
        const out = await agentRunScope.run({ runId: params.runId, explicit: true, auditIds: step.auditIds }, () => tool.run(parsed.data, ctx));
        step.outcome = out.isError ? 'error' : 'ok';
        step.summary = out.summary ?? '';
        step.result = truncate(out.content, 600);
        lines.push(`${item.label}: ${out.isError ? truncate(out.content, 160) : (out.summary ?? 'erledigt')}`);
      } catch (err) {
        step.outcome = 'error';
        step.result = toErrorInfo(err).message;
        lines.push(`${item.label}: ${toErrorInfo(err).message}`);
      }
      step.durationMs = Date.now() - t0;
    }
    this.runs.appendSteps(params.runId, steps);
    const failed = steps.filter((s) => s.outcome === 'error').length;
    if (failed === steps.length && steps.length) throw new AppError('validation_error', `Nichts ausgeführt: ${lines.join('; ')}`);
    return lines.join('\n');
  }

  // ---------- undo & corrections ----------
  async undoRun(runId: string): Promise<UndoRunResult> {
    const run = this.runs.get(runId);
    const res = await this.runs.undoRun(runId);
    if (res.undone) this.recordUndoCorrection(run, null);
    return res;
  }

  async undoStep(runId: string, stepId: string): Promise<UndoRunResult> {
    const run = this.runs.get(runId);
    const res = await this.runs.undoStep(runId, stepId);
    if (res.undone) this.recordUndoCorrection(run, stepId);
    return res;
  }

  /** Undoing the agent's work is a correction: stored, never silently changing behaviour (#315). */
  private recordUndoCorrection(run: AgentRun, stepId: string | null): void {
    const steps = run.steps.filter((s) => (stepId ? s.id === stepId : s.outcome === 'ok' && s.risk !== 'read'));
    for (const s of steps) this.memory.recordCorrection({ did: s.label, instead: 'vom Benutzer rückgängig gemacht', key: `undo:${s.tool}` });
  }

  /**
   * The user moved a document the agent had filed: stored as a correction; after several similar ones the agent proposes a
   * rule – stored only after confirmation (#315).
   */
  noticeUserRelocation(documentId: string, fromFolder: string, toFolder: string, docType: string | null, ext: string): void {
    const key = `folder:${(docType ?? ext).toLowerCase()}→${toFolder.toLowerCase()}`;
    const n = this.memory.recordCorrection({ did: `${docType ?? ext}-Datei nach ${fromFolder} abgelegt`, instead: `nach ${toFolder}`, key });
    if (n < CORRECTIONS_FOR_RULE) return;
    const name = `${docType ?? `.${ext}`} → ${toFolder}`;
    if (this.memory.list('rule').some((r) => r.name === name)) return;
    const rule = docType ? { when: { docType }, then: { folder: toFolder } } : { when: { ext }, then: { folder: toFolder } };
    this.deps.insights.upsert({
      kind: 'learned_rule',
      title: `Soll ich ${docType ?? `.${ext}-Dateien`} künftig nach ${toFolder} legen?`,
      explanation: `Du hast ${n}× ${docType ?? `.${ext}-Dateien`}, die ich abgelegt hatte, nach ${toFolder} verschoben. Mit einer Regel lege ich solche Dateien künftig gleich dort ab. Gespeichert wird sie erst, wenn du zustimmst.`,
      confidence: 0.7,
      affected: [{ type: 'document', id: documentId, label: name }],
      action: {
        label: 'Regel speichern',
        proposal: {
          actionType: 'agent_batch',
          label: `Regel „${name}“ speichern`,
          rationale: 'Aus wiederholten Korrekturen gelernt.',
          confidence: 0.7,
          affectedEntities: [],
          requiredConfirmation: 'confirm',
          proposedParameters: {
            runId: newId(),
            items: [
              {
                tool: 'remember',
                args: { kind: 'rule', name, content: `${docType ?? `.${ext}-Dateien`} immer nach ${toFolder}`, rule },
                label: `Regel „${name}“ speichern`,
                risk: 'write',
                reason: '',
              },
            ],
            refs: { ids: {}, sets: {} },
          },
        },
      },
      dedupeKey: `learned-rule:${key}`,
    });
  }

  // ---------- agent-only tools ----------
  private askTool(): AgentTool {
    return defineTool({
      name: ASK_USER,
      description:
        'Rückfrage an den Benutzer, wenn etwas unklar ist und du es nicht selbst herausfinden kannst. Der Lauf wartet auf die Antwort und setzt dann mit vollem Kontext fort.',
      schema: AskUserArgs,
      risk: 'read',
      label: () => 'Rückfrage an dich',
      run: async () => ({ content: '' }),
    });
  }

  private undoTool(): AgentTool {
    return defineTool({
      name: 'undo_previous_run',
      description:
        'Macht die Änderungen des vorigen Agentenlaufs in diesem Gespräch rückgängig (in umgekehrter Reihenfolge, mit Konfliktprüfung) – nur auf Wunsch des Benutzers.',
      schema: z.object({}),
      risk: 'write',
      label: () => 'Mache den vorigen Lauf rückgängig',
      run: async (_a, ctx) => {
        if (!ctx.conversationId) return { content: 'Nur im Gespräch möglich.', isError: true };
        const previous = this.runs.list({ conversationId: ctx.conversationId, limit: 10 }).find((r) => r.id !== ctx.runId && r.undoable > 0);
        if (!previous) return { content: 'Es gibt keinen vorigen Lauf mit rückgängig zu machenden Änderungen.', summary: 'nichts zu tun' };
        const res = await this.undoRun(previous.id);
        return {
          content: `${res.message}${res.conflicts.length ? ` Konflikte: ${res.conflicts.join(' ')}` : ''}`,
          summary: res.message,
          isError: !res.undone && res.failed > 0,
        };
      },
    });
  }

  /** Labels of the tool kinds for the run view. */
  static typeLabel(type: string): string {
    return TYPE_LABEL[type as keyof typeof TYPE_LABEL] ?? type;
  }
}
