import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { snapshot } from '../eval/checks';
import { BASE_DOCS, EMPTY_FOLDERS, buildArchive } from '../eval/fixture';
import { providersFromEnv, selectTasks } from '../eval/runner';
import { MUST_HAVE, STORIES, TASKS } from '../eval/tasks';

// Keeps the agent evaluation (#316) from rotting without spending money: the task set and the archive builder run here
// against the FakeLlm; the real evaluation (`npm run eval:agent`) is never part of the normal suite.
describe('agent evaluation: task set', () => {
  it('has 40–60 tasks with unique ids, a check and a request each', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(40);
    expect(TASKS.length).toBeLessThanOrEqual(60);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) {
      expect(typeof t.check, t.id).toBe('function');
      expect(Boolean(t.messages?.length) !== Boolean(t.background), `${t.id}: either messages or a background run`).toBe(true);
    }
  });

  it('covers the must-have examples and every story of the epic', () => {
    const ids = new Set(TASKS.map((t) => t.id));
    for (const id of MUST_HAVE) expect(ids.has(id), id).toBe(true);
    const stories = new Set(TASKS.map((t) => t.story));
    for (const s of STORIES) expect(stories.has(s), s).toBe(true);
  });

  it('fixture keys referenced by tasks are unique across base archive and task documents', () => {
    for (const t of TASKS) {
      const keys = [...BASE_DOCS, ...(t.fixture?.docs ?? [])].map((d) => d.key);
      expect(new Set(keys).size, t.id).toBe(keys.length);
    }
  });

  it('reads providers and the task filter from the environment', () => {
    expect(providersFromEnv({}).providers).toEqual([]);
    const env = {
      ARCHIVIST_EVAL_PROVIDERS: 'claude, gpt-5',
      ARCHIVIST_EVAL_CLAUDE_BASE_URL: 'https://x.services.ai.azure.com/anthropic',
      ARCHIVIST_EVAL_CLAUDE_MODEL: 'claude-opus-5-5',
      ARCHIVIST_EVAL_CLAUDE_API_KEY: 'k',
      ARCHIVIST_EVAL_GPT_5_BASE_URL: 'https://x.openai.azure.com/openai/v1',
    };
    const { providers, problems } = providersFromEnv(env);
    expect(providers).toEqual([
      { name: 'claude', baseUrl: env.ARCHIVIST_EVAL_CLAUDE_BASE_URL, model: 'claude-opus-5-5', apiKey: 'k', effort: 'high', adapter: 'auto', limits: {} },
    ]);
    const budgets = providersFromEnv({ ...env, ARCHIVIST_EVAL_CLAUDE_MAX_ROUNDS: '30', ARCHIVIST_EVAL_CLAUDE_TIMEOUT_S: '120' });
    expect(budgets.providers[0]!.limits).toEqual({ maxRounds: 30, timeoutMs: 120_000 });
    expect(providersFromEnv({ ...env, ARCHIVIST_EVAL_CLAUDE_MAX_TOKENS: 'viel' }).problems[0]).toContain('ARCHIVIST_EVAL_CLAUDE_MAX_TOKENS');
    expect(problems[0]).toContain('ARCHIVIST_EVAL_GPT_5_MODEL');
    expect(selectTasks(TASKS, 'move-slides,#309').map((t) => t.id)).toEqual(TASKS.filter((t) => t.id === 'move-slides' || t.story === '#309').map((t) => t.id));
  });
});

describe('agent evaluation: archive builder', () => {
  let app: TestApp | null = null;
  afterEach(async () => {
    await app?.cleanup();
    app = null;
  });

  it('builds the base archive deterministically without any LLM call', async () => {
    app = await createTestApp({ privacy: 'auto', agent: true });
    const task = TASKS.find((t) => t.id === 'learn-rule-stadtwerke')!;
    const docs = [...BASE_DOCS, ...(task.fixture?.docs ?? [])];
    const ids = await buildArchive(app, docs);
    expect(Object.keys(ids)).toHaveLength(docs.length);
    expect(BASE_DOCS.length).toBeGreaterThanOrEqual(30);
    expect(BASE_DOCS.length).toBeLessThanOrEqual(45);
    // nothing went to the (fake) model during setup, and the privacy mode is restored
    expect(app.llm.calls).toHaveLength(0);
    expect(app.llm.agentRequests).toHaveLength(0);
    expect(app.llm.embeddingRequests).toHaveLength(0);
    expect(app.services.settings.get().privacy.llmMode).toBe('auto');

    const s = snapshot(app.services);
    const doc = (key: string) => s.docs[ids[key]!]!;
    expect(doc('folien-q1').archiveRelPath).toMatch(/^arbeit\/allgemein\/.*\.pptx$/);
    expect(app.services.documents.getRow(ids['folien-q1']!).extractedText).toContain('Umsatz +4 %');
    expect(doc('rechnung-maler-2025')).toMatchObject({ status: 'archived', docType: 'Rechnung', topic: 'Handwerker' });
    expect(doc('rechnung-maler-2025').documentDate?.slice(0, 10)).toBe('2025-03-14');
    expect(doc('rechnung-stadtwerke-2026-09').status).toBe('proposed');
    expect(doc('arztbrief').llmStatus).toBe('excluded');
    expect(app.services.categories.list().map((c) => c.path)).toEqual(expect.arrayContaining(EMPTY_FOLDERS));
    // the deterministic tools see what the checks expect
    expect(app.services.documents.getRow(ids['mietvertrag-2026']!).extractedText).toContain('Kündigungsfrist: 3 Monate zum Vertragsende');
  });
});
