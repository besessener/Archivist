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

const totalTokens = (tokens: TaskResult['tokens']) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

export function summarize(results: TaskResult[]): ProviderSummary[] {
  const byProvider = new Map<string, TaskResult[]>();
  for (const result of results) byProvider.set(result.provider, [...(byProvider.get(result.provider) ?? []), result]);
  return [...byProvider].map(([provider, providerResults]) => {
    const passed = providerResults.filter((result) => result.pass).length;
    return {
      provider,
      model: providerResults[0]!.model,
      effort: providerResults[0]!.effort,
      tasks: providerResults.length,
      passed,
      passRate: providerResults.length ? passed / providerResults.length : 0,
      costUsd: Math.round(providerResults.reduce((sum, result) => sum + (result.costUsd ?? 0), 0) * 10_000) / 10_000,
      costIncomplete: providerResults.some((result) => result.costUsd === null && result.runIds.length > 0),
      tokens: providerResults.reduce((sum, result) => sum + totalTokens(result.tokens), 0),
      avgRounds: providerResults.length ? providerResults.reduce((sum, result) => sum + result.rounds, 0) / providerResults.length : 0,
      avgDurationMs: providerResults.length ? providerResults.reduce((sum, result) => sum + result.durationMs, 0) / providerResults.length : 0,
    };
  });
}

/** Newest earlier results file, if any. */
export function previousReport(dir = RESULTS_DIR, exclude?: string): { file: string; report: EvalReport } | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => /^agent-.*\.json$/.test(file) && path.join(dir, file) !== exclude)
    .toSorted();
  for (const file of files.toReversed()) {
    try {
      return { file, report: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as EvalReport };
    } catch {
      // unreadable file: try the one before
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

const resultKey = (result: TaskResult) => `${result.provider}|${result.taskId}`;

export function compare(current: TaskResult[], previous: TaskResult[]): Comparison {
  const previousByKey = new Map(previous.map((result) => [resultKey(result), result]));
  const newFailures = current.filter((result) => !result.pass && previousByKey.get(resultKey(result))?.pass === true);
  const fixed = current.filter((result) => result.pass && previousByKey.get(resultKey(result))?.pass === false);
  const previousSummary = new Map(summarize(previous).map((summary) => [summary.provider, summary]));
  const deltas = summarize(current).map((summary) => {
    const before = previousSummary.get(summary.provider);
    return {
      provider: summary.provider,
      passRate: before ? summary.passRate - before.passRate : null,
      costUsd: before ? summary.costUsd - before.costUsd : null,
    };
  });
  return { newFailures, fixed, deltas };
}

const percent = (x: number) => `${Math.round(x * 100)} %`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const cell = (s: string) => s.replace(/[\\|]/g, '\\$&').replace(/\s+/g, ' ').trim();
const signed = (x: number, format: (value: number) => string) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${format(Math.abs(x))}`;

type PreviousReport = { file: string; report: EvalReport } | null;

function overviewSection(report: EvalReport, summary: ProviderSummary[]): string[] {
  const lines = [
    `# Evaluation des Agenten – ${report.startedAt}`,
    '',
    `Gestartet ${report.startedAt}, fertig ${report.finishedAt}. Aufgaben je Anbieter: ${summary[0]?.tasks ?? 0}.`,
    '',
    '## Überblick',
    '',
    '| Anbieter | Modell | Effort | bestanden | Quote | Kosten | Tokens | Ø Runden | Ø Dauer |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of summary)
    lines.push(
      `| ${cell(s.provider)} | ${cell(s.model)} | ${s.effort} | ${s.passed}/${s.tasks} | ${percent(s.passRate)} | ${usd(s.costUsd)}${s.costIncomplete ? ' (ohne Preis für einige Läufe)' : ''} | ${s.tokens.toLocaleString('de-DE')} | ${s.avgRounds.toFixed(1)} | ${seconds(s.avgDurationMs)} |`,
    );
  const total = summary.reduce((sum, s) => sum + s.costUsd, 0);
  lines.push('', `**Kosten dieses Laufs: ${usd(total)}** (Schätzung aus der Preistabelle; ohne den einmaligen Verbindungstest je Anbieter).`, '');
  for (const provider of report.providers) if (provider.capability) lines.push(`- ${provider.name}: ${provider.capability}`);
  lines.push('');
  return lines;
}

function comparisonSection(report: EvalReport, previous: PreviousReport): string[] {
  if (!previous) return ['_Kein früheres Ergebnis in eval-results/ – kein Vergleich._', ''];
  const comparison = compare(report.results, previous.report.results);
  const lines = [`## Vergleich mit ${previous.file}`, ''];
  for (const delta of comparison.deltas)
    lines.push(
      `- ${delta.provider}: Quote ${delta.passRate === null ? 'neu' : signed(delta.passRate, percent)}, Kosten ${delta.costUsd === null ? 'neu' : signed(delta.costUsd, usd)}`,
    );
  lines.push('', `### Neue Fehlschläge (${comparison.newFailures.length})`, '');
  if (!comparison.newFailures.length) lines.push('Keine.');
  for (const r of comparison.newFailures) lines.push(`- **${r.provider} / ${r.taskId}** (${r.story}): ${cell(r.reasons.join('; '))}`);
  lines.push('', `### Behoben (${comparison.fixed.length})`, '');
  if (!comparison.fixed.length) lines.push('Keine.');
  for (const r of comparison.fixed) lines.push(`- **${r.provider} / ${r.taskId}** (${r.story})`);
  lines.push('');
  return lines;
}

function resultMark(result: TaskResult, before: TaskResult | undefined): string {
  if (result.pass) return before?.pass === false ? 'bestanden (**behoben**)' : 'bestanden';
  return before?.pass === true ? 'FEHLER (**neu**)' : 'FEHLER';
}

function providerSection(summary: ProviderSummary, rows: { results: TaskResult[]; previous: Map<string, TaskResult> }): string[] {
  const lines = [
    `## ${summary.provider} (${summary.model}, Effort ${summary.effort})`,
    '',
    '| Aufgabe | Story | Ergebnis | Status | Runden | Tokens | Kosten | Dauer | Grund |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows.results.filter((result) => result.provider === summary.provider)) {
    const mark = resultMark(r, rows.previous.get(resultKey(r)));
    lines.push(
      `| ${r.taskId} | ${r.story} | ${mark} | ${r.statuses.join(' → ') || '–'} | ${r.rounds} | ${totalTokens(r.tokens).toLocaleString('de-DE')} | ${r.costUsd === null ? '–' : usd(r.costUsd)} | ${seconds(r.durationMs)} | ${cell(r.reasons.join('; '))} |`,
    );
  }
  lines.push('');
  return lines;
}

export function markdown(report: EvalReport, previous: PreviousReport): string {
  const summary = summarize(report.results);
  const previousResults = new Map((previous?.report.results ?? []).map((result) => [resultKey(result), result]));
  const lines = [
    ...overviewSection(report, summary),
    ...comparisonSection(report, previous),
    ...summary.flatMap((s) => providerSection(s, { results: report.results, previous: previousResults })),
  ];
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
