import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentAdapterChoice, AgentEffort, type AgentCapability, type AgentLimits, type AgentRun } from '@archivist/shared';
import { createServices, type Services } from '../../packages/core/src';
import { detectAdapter } from '../../packages/core/src/agent/adapters';
import { MIGRATIONS, TestCipher } from '../helpers/harness';
import { snapshot, type CheckContext, type EvalTask, type Reply } from './checks';
import { buildArchive } from './archive-builder';
import { BASE_DOCS } from './fixture';

/** One configured model endpoint (from ARCHIVIST_EVAL_* environment variables). */
export interface EvalProvider {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  effort: AgentEffort;
  adapter: AgentAdapterChoice;
  /** Budgets for this provider (rounds, tokens, time) – to tune them against pass rate and cost. */
  limits: Partial<AgentLimits>;
}

const envKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** Optional budgets of one provider; returns the name of an invalid variable instead. */
function limitsFromEnv(env: NodeJS.ProcessEnv, prefix: string): Partial<AgentLimits> | string {
  const limits: Partial<AgentLimits> = {};
  const read = (suffix: string, key: keyof AgentLimits, factor = 1): string | null => {
    const raw = env[`${prefix}_${suffix}`]?.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return `${prefix}_${suffix}`;
    limits[key] = value * factor;
    return null;
  };
  return read('MAX_ROUNDS', 'maxRounds') ?? read('MAX_TOKENS', 'maxTokens') ?? read('TIMEOUT_S', 'timeoutMs', 1000) ?? limits;
}

/** Providers from ARCHIVIST_EVAL_PROVIDERS and ARCHIVIST_EVAL_<NAME>_* (see docs/how-to/agent-evaluieren.md); incomplete ones are reported, not used. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): { providers: EvalProvider[]; problems: string[] } {
  const names = (env.ARCHIVIST_EVAL_PROVIDERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const providers: EvalProvider[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const prefix = `ARCHIVIST_EVAL_${envKey(name)}`;
    const baseUrl = env[`${prefix}_BASE_URL`]?.trim() ?? '';
    const model = env[`${prefix}_MODEL`]?.trim() ?? '';
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    const missing = [!baseUrl && `${prefix}_BASE_URL`, !model && `${prefix}_MODEL`, !apiKey && `${prefix}_API_KEY`].filter(Boolean);
    if (missing.length) {
      problems.push(`${name}: ${missing.join(', ')} fehlt`);
      continue;
    }
    const effort = AgentEffort.safeParse(env[`${prefix}_EFFORT`]?.trim() || 'high');
    const adapter = AgentAdapterChoice.safeParse(env[`${prefix}_ADAPTER`]?.trim() || 'auto');
    if (!effort.success || !adapter.success) {
      problems.push(`${name}: ungültiger Wert für ${!effort.success ? `${prefix}_EFFORT` : `${prefix}_ADAPTER`}`);
      continue;
    }
    const limits = limitsFromEnv(env, prefix);
    if (typeof limits === 'string') {
      problems.push(`${name}: ungültiger Wert für ${limits}`);
      continue;
    }
    providers.push({ name, baseUrl, model, apiKey, effort: effort.data, adapter: adapter.data, limits });
  }
  return { providers, problems };
}

/** ARCHIVIST_EVAL_TASKS: comma list of task ids or stories (#309) to run only those; empty = all. */
export function selectTasks(tasks: EvalTask[], filter = process.env.ARCHIVIST_EVAL_TASKS ?? ''): EvalTask[] {
  const wanted = filter
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!wanted.length) return tasks;
  return tasks.filter((task) => wanted.includes(task.id) || wanted.includes(task.story) || wanted.includes(task.story.slice(1)));
}

export interface EvalApp {
  root: string;
  home: string;
  services: Services;
  /** HTTP requests to the model endpoint (all of them, also outside agent runs). */
  requests: { count: number };
  cleanup(): Promise<void>;
}

/** A complete application in a temp dir talking to the REAL endpoint of the provider (real fetch). */
export function createEvalApp(provider: EvalProvider): EvalApp {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-eval-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const requests = { count: 0 };
  const services = createServices({
    dataRoot: path.join(root, 'Archivist'),
    migrationsFolder: MIGRATIONS,
    cipher: new TestCipher(),
    fetchImpl: (...args: Parameters<typeof fetch>) => {
      requests.count += 1;
      return fetch(...args);
    },
    workerFile: null,
    jobConcurrency: 1,
    jobRetryDelayMs: 0,
  });
  services.settings.update({
    llm: { baseUrl: provider.baseUrl, model: provider.model },
    // local only until the archive is built; the task switches to „automatisch“
    privacy: { llmMode: 'local_only' },
    agent: { enabled: true, adapter: provider.adapter, effort: provider.effort },
    setupCompleted: true,
  });
  services.secrets.setApiKey(provider.apiKey);
  services.jobs.start();
  return {
    root,
    home,
    services,
    requests,
    async cleanup() {
      await services.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const CAPABILITY_KEY = 'agent.capability';

/** Tool-calling test once per provider (one small request pair); its result is reused by every task app. */
export async function probeProvider(provider: EvalProvider): Promise<AgentCapability | null> {
  const app = createEvalApp(provider);
  try {
    app.services.settings.update({ privacy: { llmMode: 'auto' } });
    await app.services.agent.ensureCapable();
    return app.services.agent.capability();
  } finally {
    await app.cleanup();
  }
}

/** One task on one provider whose tool calling was tested beforehand. */
export interface TaskRun {
  provider: EvalProvider;
  task: EvalTask;
  capability: AgentCapability;
}

/** Stores the probe result like the app does, so a task app does not test the endpoint again. */
function seedCapability(app: EvalApp, run: TaskRun): void {
  const { provider } = run;
  const key = `${provider.baseUrl.trim()}|${provider.model.trim()}|${detectAdapter(provider.baseUrl.trim(), provider.adapter)}`;
  app.services.appState.set(CAPABILITY_KEY, JSON.stringify({ key, cap: run.capability }));
}

export interface TaskResult {
  provider: string;
  model: string;
  effort: AgentEffort;
  taskId: string;
  story: string;
  title: string;
  pass: boolean;
  reasons: string[];
  /** status of every run (in order) */
  statuses: string[];
  rounds: number;
  requests: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** null when the model is not in the price table */
  costUsd: number | null;
  durationMs: number;
  runIds: string[];
  /** last answer, shortened */
  answer: string;
}

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function sumRuns(runs: AgentRun[]) {
  const tokens = emptyTokens();
  let cost: number | null = runs.length ? 0 : null;
  for (const run of runs) {
    tokens.input += run.usage.inputTokens;
    tokens.output += run.usage.outputTokens;
    tokens.cacheRead += run.usage.cacheReadTokens;
    tokens.cacheWrite += run.usage.cacheWriteTokens;
    cost = cost === null || run.costUsd === null ? null : cost + run.costUsd;
  }
  return { tokens, cost: cost === null ? null : Math.round(cost * 10_000) / 10_000, rounds: runs.reduce((sum, run) => sum + run.rounds, 0) };
}

/** The provider's budgets first, a task's own limits (e.g. a deliberately low brake) win. */
function configureTask(services: Services, run: TaskRun): void {
  const { task } = run;
  services.settings.update({
    privacy: { llmMode: 'auto' },
    agent: {
      mode: task.mode ?? 'auto',
      ...(task.agent?.massActionThreshold ? { massActionThreshold: task.agent.massActionThreshold } : {}),
      chatLimits: { ...services.settings.get().agent.chatLimits, ...run.provider.limits, ...task.agent?.chatLimits },
      backgroundLimits: { ...services.settings.get().agent.backgroundLimits, ...run.provider.limits },
    },
  });
}

/** What a task did: the replies in order and the agent runs behind them; `failure` stops the task before its check. */
interface TaskTranscript {
  replies: Reply[];
  runs: AgentRun[];
  failure?: string;
}

/** A task in progress inside its app: the archive ids and the transcript so far. */
interface TaskSession {
  services: Services;
  task: EvalTask;
  ids: Record<string, string>;
  transcript: TaskTranscript;
}

async function runInBackground({ services, task, ids, transcript }: TaskSession): Promise<void> {
  const background = task.background!;
  const docIds = background === 'inbox' ? (task.fixture?.docs ?? []).filter((doc) => !doc.folder).map((doc) => ids[doc.key]!) : [];
  const run = await services.agent.runBackground(background, { docIds });
  if (!run) {
    transcript.failure = 'Hintergrundlauf wurde nicht gestartet';
    return;
  }
  transcript.runs.push(services.agentRuns.get(run.id));
  transcript.replies.push({ content: run.summary, status: run.status, runId: run.id, actionIds: [], quickReplies: [] });
}

async function chatMessages({ services, task, transcript }: TaskSession): Promise<void> {
  let conversationId: string | undefined;
  for (const message of task.messages ?? []) {
    const previous = transcript.replies.at(-1);
    const text = typeof message === 'string' ? message : previous ? message(previous) : null;
    if (text === null) return;
    const response = await services.chat.send(conversationId, text);
    conversationId = response.conversationId;
    const reply = response.assistantMessage;
    const run = reply.runId ? services.agentRuns.get(reply.runId) : null;
    if (run) transcript.runs.push(run);
    transcript.replies.push({
      content: reply.content,
      status: run?.status ?? null,
      runId: reply.runId ?? null,
      actionIds: reply.actions.map((action) => action.id),
      quickReplies: reply.quickReplies,
    });
    if (!run) {
      transcript.failure = `keine Agentenantwort (regelbasierter Chat?): ${reply.errorMessage ?? reply.content.slice(0, 200)}`;
      return;
    }
  }
}

function taskResult(
  run: TaskRun,
  outcome: { app: EvalApp; transcript: TaskTranscript; startedAt: number; verdict: { pass: boolean; reasons: string[] } },
): TaskResult {
  const { provider, task } = run;
  const { runs, replies } = outcome.transcript;
  const sum = sumRuns(runs);
  return {
    provider: provider.name,
    model: provider.model,
    effort: provider.effort,
    taskId: task.id,
    story: task.story,
    title: task.title,
    pass: outcome.verdict.pass,
    reasons: outcome.verdict.reasons,
    statuses: runs.map((agentRun) => agentRun.status),
    rounds: sum.rounds,
    requests: outcome.app.requests.count,
    tokens: sum.tokens,
    costUsd: sum.cost,
    durationMs: Date.now() - outcome.startedAt,
    runIds: runs.map((agentRun) => agentRun.id),
    answer: (replies.at(-1)?.content ?? '').slice(0, 600),
  };
}

/** Builds the archive, runs the messages or the background run and checks the outcome. */
async function performTask(app: EvalApp, run: TaskRun, transcript: TaskTranscript): Promise<{ pass: boolean; reasons: string[] }> {
  const { services } = app;
  const { task } = run;
  const ids = await buildArchive(app, [...BASE_DOCS, ...(task.fixture?.docs ?? [])]);
  await task.fixture?.setup?.({ services, ids });
  if (app.requests.count) throw new Error(`setup made ${app.requests.count} request(s) to the model`);
  seedCapability(app, run);
  configureTask(services, run);
  const before = snapshot(services);
  const session: TaskSession = { services, task, ids, transcript };
  if (task.background) await runInBackground(session);
  else await chatMessages(session);
  if (transcript.failure) return { pass: false, reasons: [transcript.failure] };
  await services.jobs.whenIdle();
  const runs = transcript.runs.map((agentRun) => services.agentRuns.get(agentRun.id));
  const context: CheckContext = {
    services,
    ids,
    before,
    after: snapshot(services),
    replies: transcript.replies,
    runs,
    answer: transcript.replies.map((reply) => reply.content).join('\n\n'),
    files: runs.flatMap((agentRun) => agentRun.files),
  };
  return task.check(context);
}

/** Builds the archive of a task (base + fixture) without LLM, then runs the messages or the background run and checks. */
export async function runTask(run: TaskRun): Promise<TaskResult> {
  const app = createEvalApp(run.provider);
  const startedAt = Date.now();
  const transcript: TaskTranscript = { replies: [], runs: [] };
  try {
    const verdict = await performTask(app, run, transcript);
    return taskResult(run, { app, transcript, startedAt, verdict });
  } catch (error) {
    const verdict = { pass: false, reasons: [`Fehler: ${error instanceof Error ? error.message : String(error)}`] };
    return taskResult(run, { app, transcript, startedAt, verdict });
  } finally {
    await app.cleanup().catch(() => undefined);
  }
}
