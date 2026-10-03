import type { AgentMode, AgentProgress, AgentRun, ModelPrice, Settings } from '@archivist/shared';
import type { AppContext } from '../context';
import type { LlmService } from '../services/llm';
import { truncate } from '../util/text';
import { createAdapter, detectAdapter } from './adapters';
import { historyWindow } from './history-window';
import type { MemoryService } from './memory';
import { costOf, emptyUsage, priceFor } from './pricing';
import { runContext, systemPrompt } from './prompt';
import { proposalCard, proposalItems, proposedText, type ProposalItem } from './proposals';
import { createToolContext, type RefStore, type ToolContext, type ToolRegistry } from './registry';
import { AgentRunner, type RunnerOptions, type RunOutcome } from './runner';
import type { RunProgress } from './run-progress';
import type { AgentRunService } from './runs';
import { maskSecrets } from './security';
import type { ToolDeps } from './tools/common';
import type { AgentMessage, ProviderAdapter } from './types';

type RunKind = ToolContext['trigger'];

export interface ExecuteOptions {
  conversationId: string | null;
  trigger: 'chat' | `background:${string}`;
  task: string;
  mode: AgentMode;
  refs: RefStore;
  history: AgentMessage[];
  persist: (runId: string, message: AgentMessage) => void;
  userText: string;
  lastAnswer: string | null;
  signal?: AbortSignal;
  job?: NonNullable<ToolContext['job']>;
  /** Secrets masked in the user's message before the run. */
  redactions?: number;
}

export interface ExecutionResult {
  outcome: RunOutcome;
  ctx: ToolContext;
  run: AgentRun;
  /** Items on the run's own proposal card. */
  proposals: number;
}

export interface ExecutorDeps {
  ctx: AppContext;
  tools: ToolDeps;
  llm: LlmService;
  runs: AgentRunService;
  memory: MemoryService;
  progress: RunProgress;
  registries: Record<RunKind, ToolRegistry>;
}

/** Everything one run carries from its start to its end. */
interface RunSetup {
  options: ExecuteOptions;
  kind: RunKind;
  settings: Settings;
  adapter: ProviderAdapter;
  price: ModelPrice | null;
  ctx: ToolContext;
  progress: AgentProgress;
  learned: { text: string; entries: ToolContext['applied'] };
  proposals: ProposalItem[];
}

const runKind = (trigger: ExecuteOptions['trigger']): RunKind => (trigger === 'chat' ? 'chat' : 'background');

function linkedController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

const startProgress = (runId: string, conversationId: string | null): AgentProgress => ({
  runId,
  conversationId,
  status: 'running',
  round: 0,
  steps: [],
  text: '',
  usage: emptyUsage(),
  costUsd: null,
});

/** Runs one agent run end to end: run log, live progress, system instructions, proposal card and learned entries. */
export class AgentRunExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(options: ExecuteOptions): Promise<ExecutionResult> {
    const setup = this.setUp(options);
    let outcome: RunOutcome;
    try {
      outcome = await this.runner(setup).run();
    } finally {
      this.deps.progress.end(setup.progress);
    }
    return this.conclude(setup, outcome);
  }

  private setUp(options: ExecuteOptions): RunSetup {
    const settings = this.deps.tools.settings.get();
    const config = this.deps.llm.adapterConfig();
    const adapter = createAdapter(detectAdapter(config.baseUrl, settings.agent.adapter), config);
    const { conversationId, mode } = options;
    const runId = this.deps.runs.start({
      conversationId,
      trigger: options.trigger,
      task: truncate(options.task, 500),
      provider: adapter.id,
      model: adapter.model,
      mode,
    });
    const controller = linkedController(options.signal);
    this.deps.progress.track(runId, controller);
    const kind = runKind(options.trigger);
    const ctx = createToolContext({
      runId,
      conversationId,
      trigger: kind,
      mode,
      refs: options.refs,
      signal: controller.signal,
      userText: options.userText,
      lastAnswer: options.lastAnswer,
      job: options.job ?? null,
    });
    const learned = this.learned(settings.agent);
    const progress = startProgress(runId, conversationId);
    this.deps.progress.show(progress);
    return { options, kind, settings, adapter, price: priceFor(adapter.model, settings.agent.prices), ctx, progress, learned, proposals: [] };
  }

  private learned(agent: Settings['agent']): RunSetup['learned'] {
    if (!agent.learning) return { text: '', entries: [] };
    const { text, used } = this.deps.memory.promptSection();
    return { text, entries: used.map((e) => ({ id: e.id, kind: e.kind, label: e.name })) };
  }

  private runner(setup: RunSetup): AgentRunner {
    const { options, kind, settings, ctx } = setup;
    const agent = settings.agent;
    // learned entries and the profile are the user's own words – secrets in them are masked like everything else (#301)
    const system = maskSecrets(
      systemPrompt({
        mode: options.mode,
        massThreshold: agent.massActionThreshold,
        learned: setup.learned.text,
        background: kind === 'background',
        context: runContext({ settings, kind, now: new Date() }),
      }),
    );
    return new AgentRunner({
      adapter: setup.adapter,
      registry: this.deps.registries[kind],
      system: system.text,
      redactions: system.count + (options.redactions ?? 0),
      history: historyWindow(options.history),
      onAppend: (message) => options.persist(ctx.runId, message),
      limits: kind === 'background' ? agent.backgroundLimits : agent.chatLimits,
      maxRetries: agent.maxRetries,
      retryDelayMs: this.deps.llm.retryDelay,
      effort: agent.effort,
      massThreshold: agent.massActionThreshold,
      ctx,
      logger: this.deps.ctx.logger,
      // web search runs in chat only; background runs never leave the archive (#301)
      webSearch: kind === 'chat' && agent.webSearch,
      propose: (proposal) => {
        setup.proposals.push(...proposalItems(proposal));
        return proposedText(proposal.reason);
      },
      ...this.liveView(setup),
    });
  }

  private liveView({ progress, price, ctx }: RunSetup): Pick<RunnerOptions, 'onStep' | 'onText' | 'onUsage'> {
    return {
      onStep: (step, all) => {
        progress.steps = all.map((s) => ({ ...s }));
        // the progress of a file job comes once per chunk – shown right away, not merged away by the throttle (#304)
        if (step.job && step.outcome === 'running') this.deps.progress.emitNow(progress);
        else this.deps.progress.emitSoon(progress);
      },
      onText: (delta, round) => {
        if (round !== progress.round) {
          progress.round = round;
          progress.text = '';
        }
        progress.text += delta;
        this.deps.progress.emitSoon(progress);
      },
      onUsage: (usage) => {
        progress.usage = usage;
        progress.costUsd = costOf(usage, price);
        this.deps.progress.emitSoon(progress);
        this.deps.runs.checkpoint(ctx.runId, { steps: progress.steps, usage });
      },
    };
  }

  private conclude(setup: RunSetup, outcome: RunOutcome): ExecutionResult {
    const { ctx, progress } = setup;
    if (setup.proposals.length) ctx.actionIds.unshift(this.proposeCard(setup, outcome));
    this.markLearnedApplied(setup, outcome.text);
    const run = this.deps.runs.finish(ctx.runId, {
      status: outcome.status,
      summary: outcome.text || outcome.error || '',
      steps: outcome.steps,
      usage: outcome.usage,
      costUsd: costOf(outcome.usage, setup.price),
      // a round is one model request (the last one usually has no tool call)
      rounds: Math.max(outcome.rounds, outcome.usage.requests),
      applied: ctx.applied,
      files: ctx.files,
      error: outcome.error,
    });
    progress.status = outcome.status;
    progress.steps = outcome.steps;
    this.deps.progress.emitNow(progress);
    this.logFinished(setup, outcome);
    return { outcome, ctx, run, proposals: setup.proposals.length };
  }

  /** Returns the card's id; the proposed steps link to it. */
  private proposeCard({ options, ctx, proposals }: RunSetup, outcome: RunOutcome): string {
    const action = this.deps.tools.actions.propose(
      proposalCard({ runId: ctx.runId, conversationId: options.conversationId, items: proposals, refs: ctx.refs.state }),
    );
    for (const step of outcome.steps) if (step.outcome === 'proposed') step.actionId = action.id;
    return action.id;
  }

  /** Learned entries the agent names with their id count as applied (#315). */
  private markLearnedApplied({ learned, ctx }: RunSetup, answer: string): void {
    const mentioned = learned.entries.filter((entry) => answer.includes(entry.id));
    for (const entry of mentioned) if (!ctx.applied.some((a) => a.id === entry.id)) ctx.applied.push(entry);
    if (mentioned.length) this.deps.memory.markApplied(mentioned.map((entry) => entry.id));
  }

  /** Cache hits are logged with every run (prompt caching, #296). */
  private logFinished({ options, adapter, ctx }: RunSetup, outcome: RunOutcome): void {
    this.deps.ctx.logger.info('agent', 'Agent run finished', {
      runId: ctx.runId,
      trigger: options.trigger,
      provider: adapter.id,
      status: outcome.status,
      rounds: outcome.rounds,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheReadTokens: outcome.usage.cacheReadTokens,
      cacheWriteTokens: outcome.usage.cacheWriteTokens,
      retries: outcome.usage.retries,
    });
  }
}
