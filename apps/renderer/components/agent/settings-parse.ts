import type { AgentSettings, BackgroundLimitKind, SettingsPatch } from '@archivist/shared';

export type AgentPatch = NonNullable<SettingsPatch['agent']>;

export interface LimitsForm {
  rounds: string;
  tokens: string;
  minutes: string;
}

export interface PriceRow {
  key: number;
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const toLimits = (limits: AgentSettings['chatLimits']): LimitsForm => ({
  rounds: String(limits.maxRounds),
  tokens: String(limits.maxTokens),
  minutes: String(Math.round((limits.timeoutMs / 60_000) * 10) / 10),
});

/** A whole number within the bounds (decimal comma allowed), else null. */
export function intIn(value: string, bounds: { min: number; max: number }): number | null {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  return rounded >= bounds.min && rounded <= bounds.max ? rounded : null;
}

/** A price of at least 0; empty counts as 0. */
function priceIn(value: string): number | null {
  if (value.trim() === '') return 0;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseLimits(form: LimitsForm, what: string): Parsed<NonNullable<AgentPatch['chatLimits']>> {
  const maxRounds = intIn(form.rounds, { min: 1, max: 1000 });
  const maxTokens = intIn(form.tokens, { min: 5_000, max: 50_000_000 });
  const minutes = Number(form.minutes.replace(',', '.'));
  if (maxRounds === null) return fail(`${what}: Runden zwischen 1 und 1000.`);
  if (maxTokens === null) return fail(`${what}: Tokens zwischen 5.000 und 50.000.000.`);
  if (!Number.isFinite(minutes) || minutes < 1 / 6 || minutes > 1440) return fail(`${what}: Zeitlimit zwischen 1 und 1440 Minuten.`);
  return { ok: true, value: { maxRounds, maxTokens, timeoutMs: Math.round(minutes * 60_000) } };
}

export function parsePrices(rows: PriceRow[]): Parsed<NonNullable<AgentPatch['prices']>> {
  const table: NonNullable<AgentPatch['prices']> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) continue;
    const [input, output, cacheRead, cacheWrite] = [priceIn(row.input), priceIn(row.output), priceIn(row.cacheRead), priceIn(row.cacheWrite)];
    if (input === null || output === null || cacheRead === null || cacheWrite === null) return fail(`Preise für „${model}“: nur Zahlen ab 0.`);
    table[model] = { input, output, cacheRead, cacheWrite };
  }
  return { ok: true, value: table };
}

export const LIMIT_KINDS: Array<[BackgroundLimitKind, string]> = [
  ['inbox', 'Neue Dateien einsortieren'],
  ['archive_check', 'Archivprüfung auswerten'],
  ['links', 'Verknüpfungen vorschlagen'],
  ['workflow', 'Eigene Abläufe (geplant)'],
];

/** Own limits per background trigger; an empty field means „wie im Hintergrund allgemein“. */
export type KindLimitsForm = Record<BackgroundLimitKind, LimitsForm>;

export const toKindLimits = (limits: AgentSettings['backgroundKindLimits']): KindLimitsForm =>
  Object.fromEntries(
    LIMIT_KINDS.map(([kind]) => {
      const own = limits[kind];
      return [
        kind,
        {
          rounds: own?.maxRounds?.toString() ?? '',
          tokens: own?.maxTokens?.toString() ?? '',
          minutes: own?.timeoutMs ? String(Math.round((own.timeoutMs / 60_000) * 10) / 10) : '',
        },
      ];
    }),
  ) as KindLimitsForm;

/** An optional whole number: undefined when empty, null when out of bounds. */
const optionalInt = (value: string, bounds: { min: number; max: number }) => (value.trim() ? intIn(value, bounds) : undefined);

type OwnLimits = NonNullable<NonNullable<AgentPatch['backgroundKindLimits']>[BackgroundLimitKind]>;

function parseOwnLimits(form: LimitsForm, label: string): Parsed<OwnLimits> {
  const maxRounds = optionalInt(form.rounds, { min: 1, max: 1000 });
  const maxTokens = optionalInt(form.tokens, { min: 5_000, max: 50_000_000 });
  const minutes = optionalInt(form.minutes, { min: 1, max: 1440 });
  if (maxRounds === null) return fail(`${label}: Runden zwischen 1 und 1000.`);
  if (maxTokens === null) return fail(`${label}: Tokens zwischen 5.000 und 50.000.000.`);
  if (minutes === null) return fail(`${label}: Zeitlimit zwischen 1 und 1440 Minuten.`);
  return {
    ok: true,
    value: {
      ...(maxRounds === undefined ? {} : { maxRounds }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(minutes === undefined ? {} : { timeoutMs: minutes * 60_000 }),
    },
  };
}

export function parseKindLimits(form: KindLimitsForm): Parsed<NonNullable<AgentPatch['backgroundKindLimits']>> {
  const limits: NonNullable<AgentPatch['backgroundKindLimits']> = {};
  for (const [kind, label] of LIMIT_KINDS) {
    const own = parseOwnLimits(form[kind], label);
    if (!own.ok) return own;
    if (Object.keys(own.value).length) limits[kind] = own.value;
  }
  return { ok: true, value: limits };
}
