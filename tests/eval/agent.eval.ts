import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentCapability } from '@archivist/shared';
import { writeReport, type EvalReport } from './report';
import { probeProvider, providersFromEnv, runTask, selectTasks, type EvalProvider, type TaskResult } from './runner';
import { TASKS } from './tasks';

// Evaluation with REAL models (#316): costs money, never part of `npm test` or CI; see docs/how-to/agent-evaluieren.md.

const { providers, problems } = providersFromEnv();
const tasks = selectTasks(TASKS);
const TASK_TIMEOUT = 20 * 60_000;

if (!providers.length) {
  const why = problems.length ? `Konfiguration unvollständig: ${problems.join('; ')}` : 'ARCHIVIST_EVAL_PROVIDERS ist nicht gesetzt';
  console.info(`Agent-Evaluation übersprungen: ${why} (siehe docs/how-to/agent-evaluieren.md).`);
  describe.skip(`agent evaluation skipped – ${why}`, () => {
    it('needs configured providers', () => undefined);
  });
} else {
  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];
  const caps = new Map<string, AgentCapability | null>();

  describe('agent evaluation with real models', () => {
    afterAll(() => {
      const report: EvalReport = {
        startedAt,
        finishedAt: new Date().toISOString(),
        providers: providers.map((p) => ({
          name: p.name,
          model: p.model,
          effort: p.effort,
          baseUrl: p.baseUrl,
          capability: caps.get(p.name)?.message ?? null,
        })),
        results,
      };
      const out = writeReport(report);
      console.log(`\nAgent-Evaluation: ${results.filter((r) => r.pass).length}/${results.length} bestanden`);
      console.log(`Bericht: ${out.md}\nErgebnisse: ${out.json}`);
      console.log(`Kosten dieses Laufs: $${out.costUsd.toFixed(4)}`);
    });

    if (problems.length) it.skip(`not used: ${problems.join('; ')}`, () => undefined);

    for (const p of providers) describeProvider(p);
  });

  function describeProvider(p: EvalProvider) {
    describe(`${p.name} (${p.model}, Effort ${p.effort})`, () => {
      beforeAll(async () => {
        caps.set(p.name, await probeProvider(p).catch(() => null));
      }, 120_000);

      for (const task of tasks)
        it(
          `${task.id} (${task.story}): ${task.title}`,
          async () => {
            const cap = caps.get(p.name);
            let r: TaskResult;
            if (!cap?.toolCalling)
              r = {
                provider: p.name,
                model: p.model,
                effort: p.effort,
                taskId: task.id,
                story: task.story,
                title: task.title,
                pass: false,
                reasons: [`Tool-Calling-Test fehlgeschlagen: ${cap?.message ?? 'Endpunkt nicht erreichbar'}`],
                statuses: [],
                rounds: 0,
                requests: 0,
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                costUsd: null,
                durationMs: 0,
                runIds: [],
                answer: '',
              };
            else r = await runTask({ provider: p, task, capability: cap });
            results.push(r);
            expect(r.pass, r.reasons.join('; ')).toBe(true);
          },
          TASK_TIMEOUT,
        );
    });
  }
}
