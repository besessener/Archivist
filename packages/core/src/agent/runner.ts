import type { AgentEffort, AgentLimits, AgentRunStatus, AgentStep, AgentUsage } from '@archivist/shared';
import { AppError, toErrorInfo } from '../util/errors';
import type { UserQuestion } from './ask-user';
import { addUsage, budgetTokens, emptyUsage } from './pricing';
import type { ToolContext, ToolRegistry } from './registry';
import { NOT_RUN, ToolExecutor, errorResult, webSearchStep, type ProposeChange } from './tool-executor';
import type { AgentMessage, AgentToolCall, AgentToolResult, ProviderAdapter, TurnRequest, TurnResult, WebSource } from './types';

/** After this many blocked repetitions the run stops. */
const MAX_LOOP_HITS = 3;

export interface RunnerOptions {
  adapter: ProviderAdapter;
  registry: ToolRegistry;
  system: string;
  /** Conversation history; the runner appends to it. */
  history: AgentMessage[];
  /** Persists one appended message (history is append-only). */
  onAppend: (message: AgentMessage) => void;
  limits: AgentLimits;
  maxRetries: number;
  retryDelayMs: number;
  effort: AgentEffort;
  maxOutputTokens?: number;
  massThreshold: number;
  ctx: ToolContext;
  /** Secrets already masked before the run (system instructions, the user's message). */
  redactions?: number;
  /** Offer the provider's web search (chat runs only, setting „Websuche“). */
  webSearch?: boolean;
  propose: ProposeChange;
  onStep?: (step: AgentStep, all: AgentStep[]) => void;
  onText?: (delta: string, round: number) => void;
  onUsage?: (usage: AgentUsage) => void;
  now?: () => number;
}

type ToolMessage = Extract<AgentMessage, { role: 'tool' }>;
type LimitReason = 'rounds' | 'tokens' | 'time' | 'loop';

export interface RunOutcome {
  status: AgentRunStatus;
  text: string;
  question: UserQuestion | null;
  usage: AgentUsage;
  rounds: number;
  steps: AgentStep[];
  limitReason: LimitReason | null;
  error: string | null;
  /** Web pages the answer is based on (web search), without duplicates. */
  webSources: WebSource[];
}

/** The loop goes on with the next model request. */
type NextRound = 'continue';

const LIMIT_TEXT: Record<LimitReason, string> = {
  rounds: 'die Höchstzahl an Arbeitsschritten',
  tokens: 'das Token-Budget dieses Laufs',
  time: 'das Zeitlimit dieses Laufs',
  loop: 'eine Schleife (wiederholt gleiche Aufrufe)',
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const isRetryable = (err: unknown) => err instanceof AppError && err.retryable;

const unexecuted = (calls: AgentToolCall[], content: string): AgentToolResult[] => calls.map((call) => errorResult(call, content));

/** The provider-neutral agent loop (#295): no fixed step count, bounded by token budget, rounds, time, loops and „Stopp“. */
export class AgentRunner {
  private usage: AgentUsage = emptyUsage();
  /** Model rounds of the loop so far (also rounds without tool calls; the wrap-up request is not counted). */
  private rounds = 0;
  private lastText = '';
  private pendingTool: ToolMessage | null = null;
  private readonly webSources = new Map<string, WebSource>();
  private readonly started: number;
  private readonly tools: ToolExecutor;

  constructor(private readonly options: RunnerOptions) {
    this.started = this.now();
    this.tools = new ToolExecutor({
      registry: options.registry,
      ctx: options.ctx,
      massThreshold: options.massThreshold,
      propose: options.propose,
      onStep: options.onStep,
      now: () => this.now(),
      redactions: options.redactions ?? 0,
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private append(message: AgentMessage): void {
    this.options.history.push(message);
    this.options.onAppend(message);
  }

  /** Tool results are written only right before the next request (a note may still be added to them). */
  private flushTool(): void {
    if (!this.pendingTool) return;
    const message = this.pendingTool;
    this.pendingTool = null;
    // a round whose only call was ask_user has no results yet – no empty tool message (its answer follows later)
    if (!message.results.length && !message.note) return;
    this.append(message);
  }

  private limitReached(): LimitReason | null {
    if (this.rounds >= this.options.limits.maxRounds) return 'rounds';
    if (this.tools.loopHits >= MAX_LOOP_HITS) return 'loop';
    if (this.now() - this.started >= this.options.limits.timeoutMs) return 'time';
    if (budgetTokens(this.usage) >= this.options.limits.maxTokens) return 'tokens';
    return null;
  }

  async run(): Promise<RunOutcome> {
    try {
      return await this.loop();
    } catch (err) {
      if (this.options.ctx.signal.aborted) return this.finish('cancelled', this.lastText);
      const info = toErrorInfo(err);
      return this.fail(info.message + (info.details ? ` (${info.details})` : ''));
    }
  }

  private async loop(): Promise<RunOutcome> {
    for (;;) {
      if (this.options.ctx.signal.aborted) return this.finish('cancelled', this.lastText);
      const limit = this.limitReached();
      if (limit) return this.wrapUp(limit);
      this.rounds += 1;
      const turn = await this.turn(this.rounds, this.options.maxOutputTokens ?? 32_000);
      if (!turn) return this.finish('cancelled', this.lastText);
      const next = await this.afterTurn(turn);
      if (next !== 'continue') return next;
    }
  }

  private async afterTurn(turn: TurnResult): Promise<RunOutcome | NextRound> {
    // cancelled while the answer was arriving: its tool calls are not executed any more
    if (this.options.ctx.signal.aborted) return this.finish('cancelled', turn.text);
    this.lastText = turn.text;
    if (turn.stopReason === 'refusal') {
      const why = turn.refusal?.explanation ? ` (${turn.refusal.explanation})` : '';
      return this.finish('refusal', turn.text || `Das Modell hat diese Anfrage abgelehnt${why}.`);
    }
    // a paused turn (server-side work) is simply sent again to continue
    if (turn.stopReason === 'pause' && !turn.toolCalls.length) return 'continue';
    if (!turn.toolCalls.length) return this.answer(turn);
    if (turn.stopReason === 'max_tokens') {
      // a tool input cut off at the output limit can still look valid – never run it
      this.pendingTool = {
        role: 'tool',
        results: unexecuted(turn.toolCalls, 'Nicht ausgeführt: Die Eingabe wurde am Ausgabelimit abgeschnitten. Teile die Arbeit in kleinere Aufrufe.'),
      };
      return 'continue';
    }
    return this.runTools(turn);
  }

  private answer(turn: TurnResult): RunOutcome {
    if (turn.stopReason === 'max_tokens' && !turn.text.trim()) return this.fail('Die Antwort des Modells wurde abgeschnitten (Ausgabelimit).');
    return this.finish('done', turn.text);
  }

  private async runTools(turn: TurnResult): Promise<RunOutcome | NextRound> {
    const { results, question } = await this.tools.executeRound(turn.toolCalls, this.rounds);
    this.pendingTool = { role: 'tool', results };
    if (question) {
      this.flushTool();
      return { ...this.outcome('ask_user', turn.text), question };
    }
    if (this.options.ctx.signal.aborted) return this.finish('cancelled', turn.text);
    return 'continue';
  }

  private outcome(status: AgentRunStatus, text: string): RunOutcome {
    return {
      status,
      text,
      question: null,
      usage: this.usage,
      rounds: this.rounds,
      steps: this.tools.steps,
      limitReason: null,
      error: null,
      webSources: [...this.webSources.values()],
    };
  }

  private finish(status: AgentRunStatus, text: string): RunOutcome {
    // cancelled while tools were pending: the history must never end with unanswered tool calls
    this.flushTool();
    const last = this.options.history.at(-1);
    if (last?.role === 'assistant' && last.toolCalls.length) this.append({ role: 'tool', results: unexecuted(last.toolCalls, NOT_RUN) });
    return this.outcome(status, text);
  }

  private fail(error: string): RunOutcome {
    return { ...this.finish('error', ''), error };
  }

  /** A limit was reached: one last request without new tool work, so the agent summarizes what is done and what is missing. */
  private async wrapUp(reason: LimitReason): Promise<RunOutcome> {
    const pending = this.pendingTool;
    let text = reason !== 'time' && pending ? await this.wrapUpAnswer(reason, pending) : '';
    if (!text.trim()) text = this.fallbackSummary(reason);
    return { ...this.finish('limit', text), limitReason: reason };
  }

  private async wrapUpAnswer(reason: LimitReason, pending: ToolMessage): Promise<string> {
    pending.note = `Technische Grenze erreicht: ${LIMIT_TEXT[reason]}. Rufe KEINE Werkzeuge mehr auf. Fasse in wenigen Sätzen zusammen, was erledigt ist und was noch fehlt, und biete an, weiterzumachen.`;
    try {
      const turn = await this.turn(this.rounds + 1, 2_000);
      if (!turn) return '';
      if (turn.toolCalls.length) this.pendingTool = { role: 'tool', results: unexecuted(turn.toolCalls, 'Nicht ausgeführt: technische Grenze erreicht.') };
      return turn.text;
    } catch {
      return ''; // the deterministic summary is enough
    }
  }

  private fallbackSummary(reason: LimitReason): string {
    const done = this.options.ctx.changes;
    const failed = this.tools.steps.filter((s) => s.outcome === 'error');
    return [
      `Ich habe ${LIMIT_TEXT[reason]} erreicht und deshalb angehalten.`,
      done.length ? `Erledigt:\n${done.map((d) => `• ${d}`).join('\n')}` : 'Geändert wurde bisher nichts.',
      failed.length ? `Nicht geklappt: ${failed.map((s) => s.label).join(', ')}.` : null,
      'Soll ich weitermachen?',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** One model request with counted, bounded retries (#302). Returns null when cancelled. */
  private async turn(round: number, maxOutputTokens: number): Promise<TurnResult | null> {
    this.flushTool();
    const { signal } = this.options.ctx;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return null;
      const timeout = this.runTimeout();
      try {
        const result = await this.options.adapter.turn(this.request(maxOutputTokens, timeout.signal), (event) => {
          if (event.type === 'text') this.options.onText?.(event.delta, round);
        });
        this.accept(result, round);
        return result;
      } catch (err) {
        if (signal.aborted) return null;
        if (timeout.signal.aborted) throw new AppError('network_error', 'Zeitlimit des Laufs erreicht.');
        if (!isRetryable(err) || attempt >= this.options.maxRetries) throw err;
        this.usage = addUsage(this.usage, { retries: 1 });
        this.options.onUsage?.(this.usage);
        await sleep(this.options.retryDelayMs * 2 ** attempt, signal);
      } finally {
        timeout.dispose();
      }
    }
  }

  /** Aborts with the user's „Stopp“ or when the run's time limit is up. */
  private runTimeout(): { signal: AbortSignal; dispose: () => void } {
    const { signal } = this.options.ctx;
    const timeLeft = this.started + this.options.limits.timeoutMs - this.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeLeft));
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      },
    };
  }

  private request(maxOutputTokens: number, signal: AbortSignal): TurnRequest {
    return {
      system: this.options.system,
      messages: this.options.history,
      tools: this.options.registry.specs(),
      maxOutputTokens,
      effort: this.options.effort,
      taskBudget: Math.max(0, this.options.limits.maxTokens - budgetTokens(this.usage)),
      purpose: 'Agent',
      documentIds: [...this.options.ctx.shared],
      redactions: this.tools.redactions,
      webSearch: this.options.webSearch ?? false,
      signal,
    };
  }

  private accept(result: TurnResult, round: number): void {
    this.usage = addUsage(this.usage, { ...result.usage, requests: 1 });
    this.options.onUsage?.(this.usage);
    const { adapter } = this.options;
    this.append({ role: 'assistant', text: result.text, toolCalls: result.toolCalls, provider: adapter.id, model: adapter.model, raw: result.raw });
    if (result.web) this.recordWeb(result.web, round);
  }

  /** Searches ran on the provider's side: they appear as steps, their pages as sources, and web content is untrusted (#301). */
  private recordWeb(web: NonNullable<TurnResult['web']>, round: number): void {
    this.options.ctx.webContent = true;
    for (const source of web.sources) if (!this.webSources.has(source.url)) this.webSources.set(source.url, source);
    for (const query of web.queries) this.tools.addStep(webSearchStep(round, { query, sources: web.sources }));
  }
}
