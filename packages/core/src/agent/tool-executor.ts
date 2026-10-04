import type { AgentStep, ToolRisk } from '@archivist/shared';
import { toErrorInfo } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { truncate } from '../util/text';
import { ASK_USER, AskUserArgs, type UserQuestion } from './ask-user';
import { gateDecision } from './gate';
import { describeIssues, riskOf, type AgentTool, type ToolContext, type ToolOutput, type ToolRegistry } from './registry';
import { agentRunScope, type AgentRunScope } from './scope';
import type { RedactionOptions } from '../util/redact';
import { findInstruction, maskSecrets } from './security';
import type { AgentToolCall, AgentToolResult, WebSource } from './types';

/** Longest tool result that goes back to the model; longer ones are cut with a hint how to page. */
const MAX_RESULT_CHARS = 14_000;
/** Same tool with the same arguments: from the third call on it is not executed again (loop detection). */
const MAX_IDENTICAL_CALLS = 2;

/** Name of the provider's server-side web search in steps (it is not a tool of the registry). */
const WEB_SEARCH = 'web_search';

export const NOT_RUN = 'Abgebrochen, bevor das Werkzeug lief.';

export interface Proposal {
  tool: AgentTool<unknown>;
  args: unknown;
  label: string;
  reason: string;
}

/** Prepares a change as a proposal instead of carrying it out; returns the text for the model. */
export type ProposeChange = (proposal: Proposal) => string;

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  ctx: ToolContext;
  massThreshold: number;
  propose: ProposeChange;
  onStep?: (step: AgentStep, all: AgentStep[]) => void;
  now: () => number;
  /** Secrets already masked before the run. */
  redactions: number;
  /** Of `redactions`: personal data. */
  personalRedactions?: number;
  masking?: RedactionOptions;
}

export interface RoundResult {
  results: AgentToolResult[];
  question: UserQuestion | null;
}

interface RunningStep {
  step: AgentStep;
  call: AgentToolCall;
  startedAt: number;
}

interface StepEnd {
  outcome: AgentStep['outcome'];
  content: string;
  summary: string;
  isError: boolean;
}

interface ValidCall {
  tool: AgentTool<unknown>;
  args: unknown;
  risk: ToolRisk;
  running: RunningStep;
}

export const errorResult = (call: AgentToolCall, content: string): AgentToolResult => ({ callId: call.id, name: call.name, content, isError: true });

/** Canonical key of a call: tool name and arguments with sorted keys. */
function callKey(call: AgentToolCall): string {
  return `${call.name}:${JSON.stringify(sortedKeys(call.args ?? {}))}`;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortedKeys(entry)]),
  );
}

function safeLabel(tool: AgentTool<unknown>, args: unknown): string {
  try {
    return tool.label(args);
  } catch {
    return tool.name;
  }
}

function bounded(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;
  return `${content.slice(0, MAX_RESULT_CHARS)}\n[… gekürzt; nutze Seiten- bzw. Abschnittsparameter für den Rest]`;
}

function runningStep(round: number, call: Omit<ValidCall, 'running'>): AgentStep {
  return {
    id: newId(),
    round,
    tool: call.tool.name,
    risk: call.risk,
    label: safeLabel(call.tool, call.args),
    summary: '',
    outcome: 'running',
    args: call.args,
    result: '',
    auditIds: [],
    actionId: null,
    startedAt: nowIso(),
    durationMs: null,
  };
}

function questionStep(round: number, question: string): AgentStep {
  return {
    id: newId(),
    round,
    tool: ASK_USER,
    risk: 'read',
    label: 'Rückfrage an dich',
    summary: truncate(question, 140),
    outcome: 'asked',
    result: '',
    auditIds: [],
    actionId: null,
    startedAt: nowIso(),
    durationMs: 0,
  };
}

export function webSearchStep(round: number, { query, sources }: { query: string; sources: WebSource[] }): AgentStep {
  return {
    id: newId(),
    round,
    tool: WEB_SEARCH,
    risk: 'read',
    label: query ? `Websuche: „${truncate(query, 100)}“` : 'Websuche',
    summary: sources.length ? `${sources.length} Quelle${sources.length === 1 ? '' : 'n'}` : '',
    outcome: 'ok',
    args: { query },
    result: sources.map((s) => s.url).join('\n'),
    auditIds: [],
    actionId: null,
    startedAt: nowIso(),
    durationMs: null,
  };
}

/** Executes the tool calls of the agent loop: validation, loop detection, the gate, the run scope and the privacy of results. */
export class ToolExecutor {
  readonly steps: AgentStep[] = [];
  /** Blocked repetitions so far (loop detection). */
  loopHits = 0;
  /** Secrets masked so far (transmission log). */
  redactions: number;
  personalRedactions: number;
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: ToolExecutorOptions) {
    this.redactions = options.redactions;
    this.personalRedactions = options.personalRedactions ?? 0;
  }

  addStep(step: AgentStep): AgentStep {
    this.steps.push(step);
    this.options.onStep?.(step, this.steps);
    return step;
  }

  /** Executes the tool calls of one round; read tools in parallel, changes one after the other, all answered together. */
  async executeRound(calls: AgentToolCall[], round: number): Promise<RoundResult> {
    const results: Array<AgentToolResult | undefined> = Array.from({ length: calls.length }, () => undefined);
    const { reads, writes } = this.partition(calls);
    await Promise.all(reads.map(async (i) => (results[i] = await this.execute(calls[i]!, round))));
    for (const i of writes) results[i] = this.options.ctx.signal.aborted ? errorResult(calls[i]!, NOT_RUN) : await this.execute(calls[i]!, round);
    const { question, rejected } = this.collectQuestion(calls, round);
    for (const [i, result] of rejected) results[i] = result;
    // the question's own result is the user's answer, added when the user replies
    const answered = results.filter((r, i): r is AgentToolResult => Boolean(r) && !(question && calls[i]!.id === question.callId));
    return { results: answered, question };
  }

  private partition(calls: AgentToolCall[]): { reads: number[]; writes: number[] } {
    const reads: number[] = [];
    const writes: number[] = [];
    calls.forEach((call, i) => {
      if (call.name === ASK_USER) return;
      (this.isRead(call) ? reads : writes).push(i);
    });
    return { reads, writes };
  }

  private isRead(call: AgentToolCall): boolean {
    const tool = this.options.registry.get(call.name);
    const parsed = tool?.schema.safeParse(call.args ?? {});
    return Boolean(tool && parsed?.success && riskOf(tool, parsed.data) === 'read');
  }

  private collectQuestion(calls: AgentToolCall[], round: number): { question: UserQuestion | null; rejected: Map<number, AgentToolResult> } {
    let question: UserQuestion | null = null;
    const rejected = new Map<number, AgentToolResult>();
    for (const [i, call] of calls.entries()) {
      if (call.name !== ASK_USER) continue;
      const parsed = AskUserArgs.safeParse(call.args ?? {});
      if (!parsed.success) rejected.set(i, errorResult(call, `Ungültige Argumente: ${describeIssues(parsed.error)}`));
      else if (question) rejected.set(i, errorResult(call, 'Nur eine Rückfrage auf einmal – diese wurde nicht gestellt.'));
      else {
        question = { callId: call.id, text: parsed.data.question, options: parsed.data.options };
        this.addStep(questionStep(round, parsed.data.question));
      }
    }
    return { question, rejected };
  }

  private async execute(call: AgentToolCall, round: number): Promise<AgentToolResult> {
    const key = callKey(call);
    const repetition = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, repetition);
    const tool = this.options.registry.get(call.name);
    if (!tool) return errorResult(call, `Unbekanntes Werkzeug „${call.name}“. Verfügbar: ${this.options.registry.names().join(', ')}.`);
    const parsed = tool.schema.safeParse(call.args ?? {});
    // invalid arguments go back to the model as an error result so it can correct itself – the run continues
    if (!parsed.success) return errorResult(call, `Ungültige Argumente: ${describeIssues(parsed.error)}`);
    const args = parsed.data;
    const risk = riskOf(tool, args);
    const step = this.addStep(runningStep(round, { tool, args, risk }));
    const running: RunningStep = { step, call, startedAt: this.options.now() };
    if (repetition > MAX_IDENTICAL_CALLS) {
      this.loopHits += 1;
      return this.complete(running, {
        outcome: 'skipped',
        content: 'Nicht erneut ausgeführt: Dieser Aufruf lief schon mit denselben Argumenten. Nutze das bisherige Ergebnis oder ändere das Vorgehen.',
        summary: 'wiederholt – übersprungen',
        isError: true,
      });
    }
    const decision = gateDecision({ tool, args, risk, ctx: this.options.ctx, massThreshold: this.options.massThreshold });
    if (decision.kind === 'block') return this.complete(running, { outcome: 'skipped', content: decision.reason, summary: 'nicht ausgeführt', isError: true });
    if (decision.kind === 'propose') {
      const text = this.options.propose({ tool, args, label: step.label, reason: decision.reason });
      return this.complete(running, { outcome: 'proposed', content: text, summary: 'als Vorschlag vorbereitet', isError: false });
    }
    return this.runTool({ tool, args, risk, running });
  }

  private async runTool(valid: ValidCall): Promise<AgentToolResult> {
    const { tool, args, running } = valid;
    let out: ToolOutput;
    try {
      out = await agentRunScope.run(this.scopeOf(running.step), () => tool.run(args, this.options.ctx));
    } catch (err) {
      const info = toErrorInfo(err);
      const content = `Fehler: ${info.message}${info.details ? ` (${truncate(info.details, 300)})` : ''}`;
      return this.complete(running, { outcome: 'error', content, summary: info.message, isError: true });
    }
    this.recordEffects(valid, out);
    // secrets are masked before anything leaves the machine – tool results included (#301)
    const masked = maskSecrets(out.content, this.options.masking);
    this.redactions += masked.count;
    this.personalRedactions += masked.personalData;
    return this.complete(running, {
      outcome: out.isError ? 'error' : 'ok',
      content: bounded(masked.text),
      summary: out.summary ?? '',
      isError: Boolean(out.isError),
    });
  }

  private recordEffects({ tool, args, risk }: ValidCall, out: ToolOutput): void {
    const { ctx } = this.options;
    if (risk !== 'read' && !out.isError) {
      ctx.changedCount += out.changed ?? tool.count?.(args, ctx) ?? 1;
      if (out.change) ctx.changes.push(out.change);
    }
    const instruction = findInstruction(out.content);
    if (instruction && !ctx.tainted) ctx.tainted = instruction;
  }

  private scopeOf(step: AgentStep): AgentRunScope {
    const { ctx } = this.options;
    return {
      runId: ctx.runId,
      explicit: ctx.trigger === 'chat',
      auditIds: step.auditIds,
      stepId: step.id,
      // a longer step (file job) shows its progress in the live view (#304)
      onProgress: (progress) => {
        step.job = { id: progress.jobId, done: progress.done, total: progress.total };
        this.options.onStep?.(step, this.steps);
      },
    };
  }

  private complete({ step, call, startedAt }: RunningStep, end: StepEnd): AgentToolResult {
    step.outcome = end.outcome;
    step.summary = end.summary;
    step.result = truncate(end.content, 600);
    step.durationMs = this.options.now() - startedAt;
    this.options.onStep?.(step, this.steps);
    return { callId: call.id, name: call.name, content: end.content, isError: end.isError };
  }
}
