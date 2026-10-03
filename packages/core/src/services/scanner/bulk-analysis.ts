import type { BulkEstimate } from '@archivist/shared';
import { and, asc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { scanFiles, scanRoots } from '../../db/schema';
import { estimateTokens } from '../../util/estimate-tokens';
import { progressLine, runSummary } from '../../util/bulk-text';
import type { JobContext, JobQueueService } from '../jobs';
import type { PrivacyService } from '../privacy';
import type { SettingsService } from '../settings';
import type { FileAnalysis, FileResult } from './file-analysis';

/** Job type of „Alle neuen Dateien analysieren“ (#228): one job over every new or changed file. */
export const SCAN_ANALYZE_ALL_JOB = 'scanner.analyzeAll';

/** Files per read; the run itself is one job, so no round trips through the UI. */
export const BULK_BATCH_SIZE = 500;
/** Characters the instructions of one analysis request add to the text. */
const PROMPT_OVERHEAD_CHARS = 2_000;
const MAX_REPORTED_FAILURES = 3;

interface Cursor {
  firstSeenAt: string;
  path: string;
}

interface BulkCheckpoint {
  cursor: Cursor | null;
  total: number;
  analyzed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

export interface BulkAnalysisDeps {
  ctx: AppContext;
  analysis: FileAnalysis;
  privacy: PrivacyService;
  settings: SettingsService;
  jobs: JobQueueService;
  /** Assignment proposals for the documents of a finished batch. */
  buildProposals: (documentIds: string[]) => void;
}

/** Analysis of all files awaiting it, in batches of 500 inside one job, with one consent and one notification. */
export class BulkFileAnalysis {
  constructor(private readonly deps: BulkAnalysisDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  private awaiting() {
    return and(inArray(scanFiles.status, ['new', 'changed']), ne(scanFiles.llmStatus, 'excluded'));
  }

  /** Ids already queued in a selection job; the bulk run leaves them to that job. */
  private queuedElsewhere(): Set<string> {
    return new Set(this.deps.jobs.activePayloads<{ fileIds?: string[] }>('scanner.analyze').flatMap((payload) => payload.fileIds ?? []));
  }

  count(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(scanFiles)
        .where(this.awaiting())
        .get()?.n ?? 0
    );
  }

  /** Files that wait, how many of them may go to the LLM (privacy mode, folder permission, exclusions) and roughly how many tokens. */
  estimate(): BulkEstimate {
    const { privacy, settings } = this.deps;
    const maxChars = settings.get().llm.maxInputChars;
    const rootAllowed = new Map(
      this.db
        .select({ id: scanRoots.id, llmAllowed: scanRoots.llmAllowed })
        .from(scanRoots)
        .all()
        .map((root) => [root.id, root.llmAllowed]),
    );
    const rows = this.db
      .select({ rootId: scanFiles.rootId, path: scanFiles.path, ext: scanFiles.ext, size: scanFiles.size })
      .from(scanFiles)
      .where(this.awaiting())
      .all();
    const eligible = rows.filter((row) => privacy.evaluate({ path: row.path, ext: row.ext, rootLlmAllowed: rootAllowed.get(row.rootId) ?? false }).allowed);
    const chars = eligible.reduce((sum, row) => sum + Math.min(row.size, maxChars) + PROMPT_OVERHEAD_CHARS, 0);
    return { total: rows.length, llmEligible: eligible.length, estimatedTokens: estimateTokens(chars) };
  }

  private nextPage(cursor: Cursor | null) {
    const after = cursor
      ? or(gt(scanFiles.firstSeenAt, cursor.firstSeenAt), and(eq(scanFiles.firstSeenAt, cursor.firstSeenAt), gt(scanFiles.path, cursor.path)))
      : undefined;
    return this.db
      .select({ id: scanFiles.id, firstSeenAt: scanFiles.firstSeenAt, path: scanFiles.path })
      .from(scanFiles)
      .where(and(this.awaiting(), after))
      .orderBy(asc(scanFiles.firstSeenAt), asc(scanFiles.path))
      .limit(BULK_BATCH_SIZE)
      .all();
  }

  /** Runs over the pages after the checkpoint's cursor; a file that fails stays `new`, but the cursor is past it. */
  async run(options: { confirmLlm: boolean; job: JobContext }): Promise<{ summary: string }> {
    const { job, confirmLlm } = options;
    const saved = (job.checkpoint ?? {}) as Partial<BulkCheckpoint>;
    const state: BulkCheckpoint = { cursor: null, total: this.count(), analyzed: 0, failed: 0, skipped: 0, failures: [], ...saved };
    const mode = this.deps.privacy.mode();
    const queued = this.queuedElsewhere();
    const started = Date.now();
    const handledBefore = state.analyzed + state.failed + state.skipped;
    for (let page = this.nextPage(state.cursor); page.length > 0; page = this.nextPage(state.cursor)) {
      const documentIds: string[] = [];
      for (const file of page) {
        job.throwIfCancelled();
        if (!queued.has(file.id)) {
          const result = await this.deps.analysis.analyzeOne(file.id, { mode, confirmLlm, job, quiet: true });
          this.tally(state, result);
          if (result.kind === 'analyzed') documentIds.push(result.documentId);
        }
        state.cursor = { firstSeenAt: file.firstSeenAt, path: file.path };
        job.saveCheckpoint(state);
        const done = state.analyzed + state.failed + state.skipped;
        job.report(
          state.total ? Math.min(1, done / state.total) : null,
          progressLine({ done, total: Math.max(state.total, done), elapsedMs: Date.now() - started, sampled: done - handledBefore }),
        );
      }
      this.deps.buildProposals(documentIds);
    }
    this.deps.analysis.announce({ analyzed: state.analyzed, failed: state.failed, failures: state.failures });
    return { summary: runSummary({ done: state.analyzed, failed: state.failed }) };
  }

  private tally(state: BulkCheckpoint, result: FileResult): void {
    if (result.kind === 'analyzed') state.analyzed += 1;
    else if (result.kind === 'skipped') state.skipped += 1;
    else {
      state.failed += 1;
      if (state.failures.length < MAX_REPORTED_FAILURES) state.failures.push(result.message);
    }
  }
}
