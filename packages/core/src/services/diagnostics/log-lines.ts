import { z } from 'zod';
import type { LogLevel } from '../../util/logger';
import { truncate } from '../../util/text';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Longest formatted line that is returned. */
export const MAX_LINE_CHARS = 500;

/** One line as the logger writes it; anything else in a log file is not returned. */
const StoredLine = z.object({
  t: z.string(),
  level: z.enum(LOG_LEVELS),
  scope: z.string(),
  msg: z.string(),
  ctx: z.record(z.string(), z.unknown()).optional(),
});
export type StoredLine = z.infer<typeof StoredLine>;

export function parseLogLine(raw: string): StoredLine | null {
  try {
    const parsed = StoredLine.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface LineFilter {
  minLevel: LogLevel;
  scope: string | null;
}

export const meetsFilter = (line: StoredLine, filter: LineFilter): boolean =>
  RANK[line.level] >= RANK[filter.minLevel] && (filter.scope === null || line.scope.toLowerCase() === filter.scope.toLowerCase());

export const formatLogLine = ({ t, level, scope, msg }: StoredLine, context: unknown): string =>
  truncate(`${t} ${level.toUpperCase()} [${scope}] ${msg}${context === undefined ? '' : ` ${JSON.stringify(context)}`}`, MAX_LINE_CHARS);

/** The newest lines that fit into `maxChars`, in their original order. */
export function newestLinesWithin(lines: readonly string[], maxChars: number): { kept: string[]; omitted: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.toReversed()) {
    used += line.length + 1;
    if (used > maxChars) break;
    kept.push(line);
  }
  return { kept: kept.toReversed(), omitted: lines.length - kept.length };
}

/** Every day from `from` to `to` (YYYY-MM-DD, inclusive). */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}
