import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare, markdown, previousReport, summarize, type EvalReport } from '../eval/report';
import type { TaskResult } from '../eval/runner';

const result = (provider: string, taskId: string, pass: boolean, extra: Partial<TaskResult> = {}): TaskResult => ({
  provider,
  model: provider === 'claude' ? 'claude-opus-5-5' : 'gpt-5',
  effort: 'high',
  taskId,
  story: '#304',
  title: taskId,
  pass,
  reasons: pass ? [] : ['Datei liegt im falschen Ordner'],
  statuses: ['done'],
  rounds: 4,
  requests: 4,
  tokens: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.01,
  durationMs: 2_000,
  runIds: ['r1'],
  answer: '',
  ...extra,
});

const report = (results: TaskResult[]): EvalReport => ({
  startedAt: '2026-10-02T10:00:00Z',
  finishedAt: '2026-10-02T10:30:00Z',
  providers: [{ name: 'claude', model: 'claude-opus-5-5', effort: 'high', baseUrl: 'https://x', capability: null }],
  results,
});

describe('agent evaluation report (#316)', () => {
  it('summarizes pass rate, cost, tokens, rounds and duration per provider; a missing price is flagged', () => {
    const [claude, gpt] = summarize([
      result('claude', 'a', true),
      result('claude', 'b', false, { costUsd: null }),
      result('gpt', 'a', true, { rounds: 2, durationMs: 1_000 }),
    ]);
    expect(claude).toMatchObject({ provider: 'claude', tasks: 2, passed: 1, passRate: 0.5, costUsd: 0.01, costIncomplete: true, tokens: 2_400, avgRounds: 4 });
    expect(gpt).toMatchObject({ provider: 'gpt', passRate: 1, costIncomplete: false, avgRounds: 2, avgDurationMs: 1_000 });
  });

  it('compares with the previous run: new failures, fixed tasks and deltas', () => {
    const previous = [result('claude', 'a', true), result('claude', 'b', false)];
    const current = [result('claude', 'a', false), result('claude', 'b', true), result('gpt', 'a', true)];
    const cmp = compare(current, previous);
    expect(cmp.newFailures.map((r) => r.taskId)).toEqual(['a']);
    expect(cmp.fixed.map((r) => r.taskId)).toEqual(['b']);
    expect(cmp.deltas).toEqual([
      { provider: 'claude', passRate: 0, costUsd: 0 },
      { provider: 'gpt', passRate: null, costUsd: null },
    ]);
  });

  it('writes the report with the cost of the run and highlights new failures and fixes', () => {
    const md = markdown(report([result('claude', 'move-slides', false), result('claude', 'sum-craftsmen-2025', true)]), {
      file: 'agent-1.json',
      report: report([result('claude', 'move-slides', true), result('claude', 'sum-craftsmen-2025', false)]),
    });
    expect(md).toContain('**Kosten dieses Laufs: $0.0200**');
    expect(md).toContain('## Vergleich mit agent-1.json');
    expect(md).toContain('### Neue Fehlschläge (1)');
    expect(md).toContain('FEHLER (**neu**)');
    expect(md).toContain('bestanden (**behoben**)');
    expect(md).toContain('Datei liegt im falschen Ordner');
    expect(markdown(report([result('claude', 'a', true)]), null)).toContain('kein Vergleich');
  });

  it('finds the newest earlier results file and skips unreadable ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-eval-'));
    try {
      expect(previousReport(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, 'agent-2026-10-01.json'), JSON.stringify(report([result('claude', 'a', true)])));
      fs.writeFileSync(path.join(dir, 'agent-2026-10-02.json'), '{ kaputt');
      fs.writeFileSync(path.join(dir, 'agent-2026-10-03.json'), JSON.stringify(report([])));
      expect(previousReport(dir, path.join(dir, 'agent-2026-10-03.json'))?.file).toBe('agent-2026-10-01.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
