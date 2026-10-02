import fs from 'node:fs';
import path from 'node:path';
import type { TaskResult } from './runner';

/** Results file of one evaluation run (eval-results/agent-<timestamp>.json). */
export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  providers: Array<{ name: string; model: string; effort: string; baseUrl: string; capability: string | null }>;
  results: TaskResult[];
}

export const RESULTS_DIR = path.resolve(__dirname, '../../eval-results');

export interface ProviderSummary {
  provider: string;
  model: string;
  effort: string;
  tasks: number;
  passed: number;
  passRate: number;
  costUsd: number;
  /** some runs had no price (model not in the table) */
  costIncomplete: boolean;
  tokens: number;
  avgRounds: number;
  avgDurationMs: number;
}

export function summarize(results: TaskResult[]): ProviderSummary[] {
  const by = new Map<string, TaskResult[]>();
  for (const r of results) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
  return [...by].map(([provider, rs]) => {
    const passed = rs.filter((r) => r.pass).length;
    return {
      provider,
      model: rs[0]!.model,
      effort: rs[0]!.effort,
      tasks: rs.length,
      passed,
      passRate: rs.length ? passed / rs.length : 0,
      costUsd: Math.round(rs.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 10_000) / 10_000,
      costIncomplete: rs.some((r) => r.costUsd === null && r.runIds.length > 0),
      tokens: rs.reduce((s, r) => s + r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite, 0),
      avgRounds: rs.length ? rs.reduce((s, r) => s + r.rounds, 0) / rs.length : 0,
      avgDurationMs: rs.length ? rs.reduce((s, r) => s + r.durationMs, 0) / rs.length : 0,
    };
  });
}

/** Newest earlier results file, if any. */
export function previousReport(dir = RESULTS_DIR, exclude?: string): { file: string; report: EvalReport } | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^agent-.*\.json$/.test(f) && path.join(dir, f) !== exclude)
    .toSorted();
  for (const f of files.toReversed()) {
    try {
      return { file: f, report: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalReport };
    } catch {
      /* unreadable file: try the one before */
    }
  }
  return null;
}

export interface Comparison {
  newFailures: TaskResult[];
  fixed: TaskResult[];
  /** cost/pass-rate delta per provider */
  deltas: Array<{ provider: string; passRate: number | null; costUsd: number | null }>;
}

export function compare(current: TaskResult[], previous: TaskResult[]): Comparison {
  const prev = new Map(previous.map((r) => [`${r.provider}|${r.taskId}`, r]));
  const newFailures = current.filter((r) => !r.pass && prev.get(`${r.provider}|${r.taskId}`)?.pass === true);
  const fixed = current.filter((r) => r.pass && prev.get(`${r.provider}|${r.taskId}`)?.pass === false);
  const prevSummary = new Map(summarize(previous).map((s) => [s.provider, s]));
  const deltas = summarize(current).map((s) => {
    const p = prevSummary.get(s.provider);
    return { provider: s.provider, passRate: p ? s.passRate - p.passRate : null, costUsd: p ? s.costUsd - p.costUsd : null };
  });
  return { newFailures, fixed, deltas };
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const signed = (x: number, fmt: (v: number) => string) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${fmt(Math.abs(x))}`;

export function markdown(report: EvalReport, previous: { file: string; report: EvalReport } | null): string {
  const lines: string[] = [];
  const summary = summarize(report.results);
  lines.push(`# Evaluation des Agenten – ${report.startedAt}`, '');
  lines.push(`Gestartet ${report.startedAt}, fertig ${report.finishedAt}. Aufgaben je Anbieter: ${summary[0]?.tasks ?? 0}.`, '');
  lines.push('## Überblick', '');
  lines.push('| Anbieter | Modell | Effort | bestanden | Quote | Kosten | Tokens | Ø Runden | Ø Dauer |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of summary)
    lines.push(
      `| ${cell(s.provider)} | ${cell(s.model)} | ${s.effort} | ${s.passed}/${s.tasks} | ${pct(s.passRate)} | ${usd(s.costUsd)}${s.costIncomplete ? ' (ohne Preis für einige Läufe)' : ''} | ${s.tokens.toLocaleString('de-DE')} | ${s.avgRounds.toFixed(1)} | ${secs(s.avgDurationMs)} |`,
    );
  const total = summary.reduce((x, s) => x + s.costUsd, 0);
  lines.push('', `**Kosten dieses Laufs: ${usd(total)}** (Schätzung aus der Preistabelle; ohne den einmaligen Verbindungstest je Anbieter).`, '');
  for (const p of report.providers) if (p.capability) lines.push(`- ${p.name}: ${p.capability}`);
  lines.push('');

  if (previous) {
    const cmp = compare(report.results, previous.report.results);
    lines.push(`## Vergleich mit ${previous.file}`, '');
    for (const d of cmp.deltas)
      lines.push(
        `- ${d.provider}: Quote ${d.passRate === null ? 'neu' : signed(d.passRate, pct)}, Kosten ${d.costUsd === null ? 'neu' : signed(d.costUsd, usd)}`,
      );
    lines.push('');
    lines.push(`### Neue Fehlschläge (${cmp.newFailures.length})`, '');
    if (!cmp.newFailures.length) lines.push('Keine.');
    for (const r of cmp.newFailures) lines.push(`- **${r.provider} / ${r.taskId}** (${r.story}): ${cell(r.reasons.join('; '))}`);
    lines.push('', `### Behoben (${cmp.fixed.length})`, '');
    if (!cmp.fixed.length) lines.push('Keine.');
    for (const r of cmp.fixed) lines.push(`- **${r.provider} / ${r.taskId}** (${r.story})`);
    lines.push('');
  } else lines.push('_Kein früheres Ergebnis in eval-results/ – kein Vergleich._', '');

  const prevMap = new Map((previous?.report.results ?? []).map((r) => [`${r.provider}|${r.taskId}`, r]));
  for (const s of summary) {
    lines.push(`## ${s.provider} (${s.model}, Effort ${s.effort})`, '');
    lines.push('| Aufgabe | Story | Ergebnis | Status | Runden | Tokens | Kosten | Dauer | Grund |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of report.results.filter((x) => x.provider === s.provider)) {
      const before = prevMap.get(`${r.provider}|${r.taskId}`);
      const mark = r.pass ? (before?.pass === false ? 'bestanden (**behoben**)' : 'bestanden') : before?.pass === true ? 'FEHLER (**neu**)' : 'FEHLER';
      const tokens = r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
      lines.push(
        `| ${r.taskId} | ${r.story} | ${mark} | ${r.statuses.join(' → ') || '–'} | ${r.rounds} | ${tokens.toLocaleString('de-DE')} | ${r.costUsd === null ? '–' : usd(r.costUsd)} | ${secs(r.durationMs)} | ${cell(r.reasons.join('; '))} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Writes JSON and Markdown; returns their paths and the total cost. */
export function writeReport(report: EvalReport, dir = RESULTS_DIR): { json: string; md: string; costUsd: number } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const json = path.join(dir, `agent-${stamp}.json`);
  const md = path.join(dir, `agent-${stamp}.md`);
  const previous = previousReport(dir, json);
  fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(md, markdown(report, previous));
  return { json, md, costUsd: summarize(report.results).reduce((s, x) => s + x.costUsd, 0) };
}
