import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentAdapterChoice, AgentEffort, type AgentCapability, type AgentRun } from '@archivist/shared';
import { createServices, type Services } from '../../packages/core/src';
import { detectAdapter } from '../../packages/core/src/agent/adapters';
import { MIGRATIONS, TestCipher } from '../helpers/harness';
import { snapshot, type CheckContext, type EvalTask, type Reply } from './checks';
import { BASE_DOCS, buildArchive } from './fixture';

/** One configured model endpoint (from ARCHIVIST_EVAL_* environment variables). */
export interface EvalProvider {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  effort: AgentEffort;
  adapter: AgentAdapterChoice;
}

const envKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * ARCHIVIST_EVAL_PROVIDERS=claude,openai and per name ARCHIVIST_EVAL_<NAME>_BASE_URL, _MODEL, _API_KEY, optional _EFFORT
 * (low … max, default high) and _ADAPTER (auto/anthropic/openai). Incomplete providers are reported, not used.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): { providers: EvalProvider[]; problems: string[] } {
  const names = (env.ARCHIVIST_EVAL_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const providers: EvalProvider[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const k = `ARCHIVIST_EVAL_${envKey(name)}`;
    const baseUrl = env[`${k}_BASE_URL`]?.trim() ?? '';
    const model = env[`${k}_MODEL`]?.trim() ?? '';
    const apiKey = env[`${k}_API_KEY`]?.trim() ?? '';
    const missing = [!baseUrl && `${k}_BASE_URL`, !model && `${k}_MODEL`, !apiKey && `${k}_API_KEY`].filter(Boolean);
    if (missing.length) {
      problems.push(`${name}: ${missing.join(', ')} fehlt`);
      continue;
    }
    const effort = AgentEffort.safeParse(env[`${k}_EFFORT`]?.trim() || 'high');
    const adapter = AgentAdapterChoice.safeParse(env[`${k}_ADAPTER`]?.trim() || 'auto');
    if (!effort.success || !adapter.success) {
      problems.push(`${name}: ungültiger Wert für ${!effort.success ? `${k}_EFFORT` : `${k}_ADAPTER`}`);
      continue;
    }
    providers.push({ name, baseUrl, model, apiKey, effort: effort.data, adapter: adapter.data });
  }
  return { providers, problems };
}

/** ARCHIVIST_EVAL_TASKS: comma list of task ids or stories (#309) to run only those; empty = all. */
export function selectTasks(tasks: EvalTask[], filter = process.env.ARCHIVIST_EVAL_TASKS ?? ''): EvalTask[] {
  const wanted = filter
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) return tasks;
  return tasks.filter((t) => wanted.includes(t.id) || wanted.includes(t.story) || wanted.includes(t.story.slice(1)));
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
export function createEvalApp(p: EvalProvider): EvalApp {
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
    llm: { baseUrl: p.baseUrl, model: p.model },
    // local only until the archive is built; the task switches to „automatisch“
    privacy: { llmMode: 'local_only' },
    agent: { enabled: true, adapter: p.adapter, effort: p.effort },
    setupCompleted: true,
  });
  services.secrets.setApiKey(p.apiKey);
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
export async function probeProvider(p: EvalProvider): Promise<AgentCapability | null> {
  const app = createEvalApp(p);
  try {
    app.services.settings.update({ privacy: { llmMode: 'auto' } });
    await app.services.agent.ensureCapable();
    return app.services.agent.capability();
  } finally {
    await app.cleanup();
  }
}

/** Stores the probe result like the app does, so a task app does not test the endpoint again. */
function seedCapability(app: EvalApp, p: EvalProvider, cap: AgentCapability): void {
  const key = `${p.baseUrl.trim()}|${p.model.trim()}|${detectAdapter(p.baseUrl.trim(), p.adapter)}`;
  app.services.appState.set(CAPABILITY_KEY, JSON.stringify({ key, cap }));
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
  for (const r of runs) {
    tokens.input += r.usage.inputTokens;
    tokens.output += r.usage.outputTokens;
    tokens.cacheRead += r.usage.cacheReadTokens;
    tokens.cacheWrite += r.usage.cacheWriteTokens;
    cost = cost === null || r.costUsd === null ? null : cost + r.costUsd;
  }
  return { tokens, cost: cost === null ? null : Math.round(cost * 10_000) / 10_000, rounds: runs.reduce((s, r) => s + r.rounds, 0) };
}

/** Builds the archive of a task (base + fixture) without LLM, then runs the messages or the background run and checks. */
export async function runTask(p: EvalProvider, task: EvalTask, cap: AgentCapability): Promise<TaskResult> {
  const app = createEvalApp(p);
  const t0 = Date.now();
  const replies: Reply[] = [];
  const runs: AgentRun[] = [];
  const result = (pass: boolean, reasons: string[]): TaskResult => {
    const sum = sumRuns(runs);
    return {
      provider: p.name,
      model: p.model,
      effort: p.effort,
      taskId: task.id,
      story: task.story,
      title: task.title,
      pass,
      reasons,
      statuses: runs.map((r) => r.status),
      rounds: sum.rounds,
      requests: app.requests.count,
      tokens: sum.tokens,
      costUsd: sum.cost,
      durationMs: Date.now() - t0,
      runIds: runs.map((r) => r.id),
      answer: (replies.at(-1)?.content ?? '').slice(0, 600),
    };
  };
  try {
    const { services } = app;
    const ids = await buildArchive(app, [...BASE_DOCS, ...(task.fixture?.docs ?? [])]);
    await task.fixture?.setup?.({ services, ids });
    if (app.requests.count) throw new Error(`setup made ${app.requests.count} request(s) to the model`);
    seedCapability(app, p, cap);
    services.settings.update({
      privacy: { llmMode: 'auto' },
      agent: {
        mode: task.mode ?? 'auto',
        ...(task.agent?.massActionThreshold ? { massActionThreshold: task.agent.massActionThreshold } : {}),
        ...(task.agent?.chatLimits ? { chatLimits: { ...services.settings.get().agent.chatLimits, ...task.agent.chatLimits } } : {}),
      },
    });
    const before = snapshot(services);

    if (task.background) {
      const docIds = task.background === 'inbox' ? (task.fixture?.docs ?? []).filter((d) => !d.folder).map((d) => ids[d.key]!) : [];
      const run = await services.agent.runBackground(task.background, { docIds });
      if (!run) return result(false, ['Hintergrundlauf wurde nicht gestartet']);
      runs.push(services.agentRuns.get(run.id));
      replies.push({ content: run.summary, status: run.status, runId: run.id, actionIds: [], quickReplies: [] });
    } else {
      let conversationId: string | undefined;
      for (const m of task.messages ?? []) {
        const prev = replies.at(-1);
        const text = typeof m === 'string' ? m : prev ? m(prev) : null;
        if (text === null) break;
        const res = await services.chat.send(conversationId, text);
        conversationId = res.conversationId;
        const msg = res.assistantMessage;
        const run = msg.runId ? services.agentRuns.get(msg.runId) : null;
        if (run) runs.push(run);
        replies.push({
          content: msg.content,
          status: run?.status ?? null,
          runId: msg.runId ?? null,
          actionIds: msg.actions.map((a) => a.id),
          quickReplies: msg.quickReplies,
        });
        if (!run) return result(false, [`keine Agentenantwort (regelbasierter Chat?): ${msg.errorMessage ?? msg.content.slice(0, 200)}`]);
      }
    }
    await services.jobs.whenIdle();
    const after = snapshot(services);
    const ctx: CheckContext = {
      services,
      ids,
      before,
      after,
      replies,
      runs: runs.map((r) => services.agentRuns.get(r.id)),
      answer: replies.map((r) => r.content).join('\n\n'),
      files: runs.flatMap((r) => services.agentRuns.get(r.id).files),
    };
    const verdict = await task.check(ctx);
    return result(verdict.pass, verdict.reasons);
  } catch (err) {
    return result(false, [`Fehler: ${err instanceof Error ? err.message : String(err)}`]);
  } finally {
    await app.cleanup().catch(() => undefined);
  }
}
