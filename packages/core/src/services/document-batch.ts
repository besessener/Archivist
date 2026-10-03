import { runSummary, progressLine } from '../util/bulk-text';
import { untilSettled } from './analysis-retry';
import type { AnalysisResult, AnalyzeOptions } from './document-analysis';
import { isJobCancelled, type JobContext, type JobQueueService } from './jobs';
import type { NotificationService } from './notifications';
import type { AppContext } from '../context';

/** Job type that analyses several documents of one import and reports once (#228). */
export const DOCUMENT_ANALYZE_BATCH_JOB = 'documents.analyzeBatch';

/** Documents per read of a source; keeps a run of 20.000 documents away from loading all ids at once. */
export const BATCH_SIZE = 500;
const MAX_REPORTED_FAILURES = 3;

export interface AnalyzeBatchPayload {
  documentIds: string[];
  allowLlm: boolean;
  /** What the import skipped before the analysis, for the final notification. */
  duplicates: number;
  rejected: number;
}

/** Where a run takes its documents from: the next ids after a cursor (document ids, ascending). */
export interface DocumentSource {
  total: number;
  next(after: string | null): string[];
}

/** Progress of a run; small enough to be saved after every document. */
export interface BatchState {
  after: string | null;
  analyzed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

export const emptyBatchState = (): BatchState => ({ after: null, analyzed: 0, failed: 0, skipped: 0, failures: [] });

/** What the batch needs of the document service (typed by shape to keep the modules acyclic). */
export interface BatchDocuments {
  analyze(id: string, opts: AnalyzeOptions): Promise<AnalysisResult>;
}

export interface BatchDeps {
  ctx: AppContext;
  documents: BatchDocuments;
  jobs: JobQueueService;
  notifications: NotificationService;
}

/** Analyses documents one after the other without a notification per document; a rate limit waits (Retry-After) and retries. */
export class DocumentBatchAnalysis {
  constructor(private readonly deps: BatchDeps) {}

  async run(
    source: DocumentSource,
    options: { allowLlm: boolean; job: JobContext; state: BatchState; onProgress: (state: BatchState) => void },
  ): Promise<BatchState> {
    const { job, state } = options;
    const started = Date.now();
    const handledBefore = state.analyzed + state.failed + state.skipped;
    for (let ids = source.next(state.after); ids.length > 0; ids = source.next(state.after)) {
      for (const id of ids) {
        job.throwIfCancelled();
        await this.analyzeOne(id, { allowLlm: options.allowLlm, job, state });
        state.after = id;
        options.onProgress(state);
        const done = state.analyzed + state.failed + state.skipped;
        job.report(
          source.total === 0 ? null : done / source.total,
          progressLine({ done, total: source.total, elapsedMs: Date.now() - started, sampled: done - handledBefore }),
        );
      }
    }
    return state;
  }

  private async analyzeOne(id: string, run: { allowLlm: boolean; job: JobContext; state: BatchState }): Promise<void> {
    const { documents, jobs, ctx } = this.deps;
    const { job, state } = run;
    try {
      const result = await untilSettled((attempt) => documents.analyze(id, { allowLlm: run.allowLlm, signal: job.signal, llmAttempt: attempt, quiet: true }), {
        backoffMs: (failed) => jobs.backoffMs(failed),
        signal: job.signal,
        onWait: (message) => job.report(null, message),
      });
      if (result.skipped) state.skipped += 1;
      else state.analyzed += 1;
    } catch (err) {
      if (isJobCancelled(err)) throw err;
      ctx.logger.warn('documents', 'Analysis in a batch failed', { documentId: id, error: err });
      state.failed += 1;
      if (state.failures.length < MAX_REPORTED_FAILURES) state.failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  /** The one notification of a run: how many were analysed, how many failed (with the first reasons) and what was skipped before. */
  announce(summary: { title: string; state: BatchState; skippedBefore?: { duplicates: number; rejected: number }; note?: string }): string {
    const { state, skippedBefore } = summary;
    const text = runSummary({ done: state.analyzed, failed: state.failed });
    const reasons = state.failures.length ? ` Grund: ${state.failures.join(' / ')}` : '';
    const skipped =
      skippedBefore && (skippedBefore.duplicates || skippedBefore.rejected)
        ? ` Übersprungen: ${skippedBefore.duplicates} Duplikate, ${skippedBefore.rejected} nicht importierbar.`
        : '';
    this.deps.notifications.create({
      title: summary.title,
      description: `${text}.${reasons}${skipped}${summary.note ?? ''}`,
      type: 'system',
      priority: state.failed > 0 ? 'normal' : 'low',
      proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
    });
    return text;
  }

  /** Handler of the batch job for the documents of one import. */
  async runImported(job: JobContext<AnalyzeBatchPayload>): Promise<{ summary: string }> {
    const ids = [...job.payload.documentIds].sort();
    const source: DocumentSource = { total: ids.length, next: (after) => ids.filter((id) => after === null || id > after).slice(0, BATCH_SIZE) };
    const state = await this.run(source, {
      allowLlm: job.payload.allowLlm,
      job,
      state: { ...emptyBatchState(), ...(job.checkpoint as Partial<BatchState> | null) },
      onProgress: (progress) => job.saveCheckpoint(progress),
    });
    const { duplicates, rejected } = job.payload;
    return { summary: this.announce({ title: 'Import abgeschlossen', state, skippedBefore: { duplicates, rejected } }) };
  }
}
