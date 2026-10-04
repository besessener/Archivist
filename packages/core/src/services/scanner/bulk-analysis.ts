import type { BulkEstimate } from '@archivist/shared';
import { and, asc, inArray, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { scanFiles, scanRoots } from '../../db/schema';
import { progressLine, runSummary } from '../../util/bulk-text';
import { estimateAnalysisTokens } from '../bulk-estimate';
import type { Job } from '@archivist/shared';
import type { JobContext, JobQueueService } from '../jobs';
import type { LlmService } from '../llm';
import type { PrivacyService } from '../privacy';
import type { NotificationService } from '../notifications';
import { pausingOnTokenCap } from '../token-cap-pause';
import type { SettingsService } from '../settings';
import type { FileAnalysis, FileResult } from './file-analysis';

/** Job type of „Alle neuen Dateien analysieren“ (#228): one job over every new or changed file. */
export const SCAN_ANALYZE_ALL_JOB = 'scanner.analyzeAll';

/** Files per read; the run itself is one job, so no round trips through the UI. */
export const BULK_BATCH_SIZE = 500;
const MAX_REPORTED_FAILURES = 3;

/** What the user confirmed: the files that were waiting at that moment; files found later are left for the next run. */
export interface BulkPayload {
  confirmLlm: boolean;
  fileIds: string[];
}

interface BulkCheckpoint {
  next: number;
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
  llm: LlmService;
  jobs: JobQueueService;
  notifications: NotificationService;
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
    const allowed = (row: (typeof rows)[number]) =>
      privacy.evaluate({ path: row.path, ext: row.ext, rootLlmAllowed: rootAllowed.get(row.rootId) ?? false }).allowed;
    const eligible = this.deps.llm.isConfigured() ? rows.filter(allowed) : [];
    // the text is only known after reading: the file size is the upper bound
    const estimatedTokens = estimateAnalysisTokens(
      eligible.map((row) => row.size),
      maxChars,
    );
    return { total: rows.length, llmEligible: eligible.length, estimatedTokens };
  }

  /** Queues the run over the files waiting now (frozen here, so the one consent covers exactly these). */
  enqueue(request: { confirmLlm: boolean }): Job {
    const fileIds = this.db
      .select({ id: scanFiles.id })
      .from(scanFiles)
      .where(this.awaiting())
      .orderBy(asc(scanFiles.firstSeenAt), asc(scanFiles.path))
      .all()
      .map((row) => row.id);
    const payload: BulkPayload = { confirmLlm: request.confirmLlm, fileIds };
    const job = this.deps.jobs.enqueue(SCAN_ANALYZE_ALL_JOB, { label: 'Analysiere alle neuen Dateien', payload, sameAs: () => true, maxAttempts: 1 });
    const active = this.deps.jobs.payloadOf<BulkPayload>(job.id);
    // a run already active without consent gets it for the files it has not reached yet
    if (request.confirmLlm && active && !active.confirmLlm) this.deps.jobs.updatePayload(job.id, { ...active, confirmLlm: true });
    return job;
  }

  /** The consent as stored now: it may have been given after the run started (it is never taken back). */
  private consented(jobId: string): boolean {
    return this.deps.jobs.payloadOf<BulkPayload>(jobId)?.confirmLlm ?? false;
  }

  /** The ids of a page that still wait (a file may have been analysed, excluded or removed since the consent), in the page's order. */
  private stillAwaiting(page: string[]): Set<string> {
    const rows = this.db
      .select({ id: scanFiles.id })
      .from(scanFiles)
      .where(and(inArray(scanFiles.id, page), this.awaiting()))
      .all();
    return new Set(rows.map((row) => row.id));
  }

  /** Runs over the frozen ids after the checkpoint; a file that fails stays `new`, but the run is past it. */
  async run(job: JobContext<BulkPayload>): Promise<{ summary: string }> {
    const { fileIds } = job.payload;
    const saved = (job.checkpoint ?? {}) as Partial<BulkCheckpoint>;
    const state: BulkCheckpoint = { next: 0, analyzed: 0, failed: 0, skipped: 0, failures: [], ...saved };
    const handled = () => state.analyzed + state.failed + state.skipped;
    await pausingOnTokenCap(() => this.analyzePages(fileIds, { state, job }), {
      notifications: this.deps.notifications,
      jobId: job.id,
      title: 'Analyse pausiert',
      progress: () => ({ done: handled(), total: fileIds.length }),
    });
    this.deps.analysis.announce({ analyzed: state.analyzed, failed: state.failed, failures: state.failures });
    return { summary: runSummary({ done: state.analyzed, failed: state.failed }) };
  }

  private async analyzePages(fileIds: string[], run: { state: BulkCheckpoint; job: JobContext<BulkPayload> }): Promise<void> {
    const { state, job } = run;
    const mode = this.deps.privacy.mode();
    const queued = this.queuedElsewhere();
    const started = Date.now();
    const handledBefore = state.analyzed + state.failed + state.skipped;
    while (state.next < fileIds.length) {
      const page = fileIds.slice(state.next, state.next + BULK_BATCH_SIZE);
      const waiting = this.stillAwaiting(page);
      const documentIds: string[] = [];
      try {
        for (const id of page) {
          job.throwIfCancelled();
          if (waiting.has(id) && !queued.has(id)) {
            const result = await this.deps.analysis.analyzeOne(id, { mode, confirmLlm: job.payload.confirmLlm || this.consented(job.id), job, quiet: true });
            this.tally(state, result);
            if (result.kind === 'analyzed') documentIds.push(result.documentId);
          }
          state.next += 1;
          job.saveCheckpoint(state);
          const done = state.analyzed + state.failed + state.skipped;
          job.report(
            Math.min(1, state.next / fileIds.length),
            progressLine({ done, total: Math.max(fileIds.length, done), elapsedMs: Date.now() - started, sampled: done - handledBefore }),
          );
        }
      } finally {
        this.deps.buildProposals(documentIds);
      }
    }
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
