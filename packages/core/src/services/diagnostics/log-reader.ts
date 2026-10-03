import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DataPaths } from '../../context';
import type { Logger, LogLevel } from '../../util/logger';
import type { ExcludedLocations } from './excluded-locations';
import { daysBetween, formatLogLine, meetsFilter, newestLinesWithin, parseLogLine, type StoredLine } from './log-lines';

/** Of a long daily file only the end is read. */
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 10_000;

export interface LogQuery {
  /** First and last day, YYYY-MM-DD (UTC, like the file names). */
  from: string;
  to: string;
  minLevel: LogLevel;
  scope: string | null;
  limit: number;
}

export interface LogReadResult {
  /** The newest matching lines, oldest first. */
  lines: string[];
  matched: number;
  /** Matching lines dropped because they name something excluded from the LLM. */
  withheld: number;
  /** Lines that are not in the format the logger writes. */
  unreadable: number;
  /** Matching lines cut off by the size limit. */
  omittedBySize: number;
  daysWithoutFile: string[];
  daysCutShort: string[];
}

export type LogReaderDeps = { paths: DataPaths; logger: Logger; excluded: ExcludedLocations };

/** Reads the daily log files for the agent: only what the logger would write, sanitised again, nothing about excluded files. */
export class LogReader {
  constructor(private readonly deps: LogReaderDeps) {}

  async read(query: LogQuery): Promise<LogReadResult> {
    const isExcluded = this.deps.excluded.current();
    const found: string[] = [];
    const result = { withheld: 0, unreadable: 0, daysWithoutFile: [] as string[], daysCutShort: [] as string[] };
    for (const day of daysBetween(query.from, query.to)) {
      const file = await readEnd(path.join(this.deps.paths.logs, `archivist-${day}.log`));
      if (!file) result.daysWithoutFile.push(day);
      else {
        if (file.cutShort) result.daysCutShort.push(day);
        const scanned = this.scan(file.text, { query, isExcluded });
        found.push(...scanned.lines);
        result.withheld += scanned.withheld;
        result.unreadable += scanned.unreadable;
      }
    }
    const { kept, omitted } = newestLinesWithin(found.slice(-query.limit), MAX_RESULT_CHARS);
    return { ...result, lines: kept, matched: found.length, omittedBySize: omitted };
  }

  private scan(text: string, { query, isExcluded }: { query: LogQuery; isExcluded: (text: string) => boolean }) {
    const scanned = { lines: [] as string[], withheld: 0, unreadable: 0 };
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      const line = parseLogLine(raw);
      if (!line) scanned.unreadable += 1;
      else if (meetsFilter(line, query)) {
        const safe = this.sanitized(line);
        if (isExcluded(safe.searchable)) scanned.withheld += 1;
        else scanned.lines.push(safe.text);
      }
    }
    return scanned;
  }

  /** The line as the logger would have written it, and the text the exclusions are compared with. */
  private sanitized(line: StoredLine): { text: string; searchable: string } {
    const { logger } = this.deps;
    const message = logger.sanitizeString(line.msg, 1000);
    const context = line.ctx ? logger.sanitizeContext(line.ctx) : undefined;
    return { text: formatLogLine({ ...line, msg: message }, context), searchable: `${message} ${JSON.stringify(context ?? '')}` };
  }
}

async function readEnd(file: string): Promise<{ text: string; cutShort: boolean } | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_BYTES_PER_FILE);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    const cutShort = size > length;
    // the first line of a tail is usually cut in the middle
    return { text: cutShort ? text.slice(text.indexOf('\n') + 1) : text, cutShort };
  } finally {
    await handle.close();
  }
}
