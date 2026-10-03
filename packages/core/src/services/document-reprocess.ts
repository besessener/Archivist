import type { BulkEstimate, Job } from '@archivist/shared';
import { inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { validationError } from '../util/errors';
import { estimateTokens } from '../util/estimate-tokens';
import { progressLine, runSummary } from '../util/bulk-text';
import { untilSettled } from './analysis-retry';
import type { DocumentService } from './documents';
import { isJobCancelled, type JobContext, type JobQueueService } from './jobs';
import type { LlmService } from './llm';
import type { NotificationService } from './notifications';
import type { PrivacyService } from './privacy';
import type { SettingsService } from './settings';

/** Job type of „Auswahl neu verarbeiten“ (#220): re-read, propose new metadata, re-index – for archived documents. */
export const DOCUMENT_REPROCESS_JOB = 'documents.reprocess';

/** Characters the instructions of one analysis request add to the text. */
const PROMPT_OVERHEAD_CHARS = 2_000;
const ID_CHUNK = 500;

export interface ReprocessPayload {
  documentIds: string[];
  reread: boolean;
  reanalyze: boolean;
  allowLlm: boolean;
}

interface ReprocessProgress {
  next: number;
  done: number;
  failed: number;
  proposals: number;
}

export interface ReprocessDeps {
  ctx: AppContext;
  documents: DocumentService;
  jobs: JobQueueService;
  notifications: NotificationService;
  privacy: PrivacyService;
  settings: SettingsService;
  llm: LlmService;
}

/** Bulk re-processing of archived documents: nothing is changed in file or location, new metadata only becomes proposals. */
export class DocumentReprocessing {
  constructor(private readonly deps: ReprocessDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  private archivedRows(ids: string[]) {
    const rows = [];
    for (let start = 0; start < ids.length; start += ID_CHUNK)
      rows.push(
        ...this.db
          .select()
          .from(documents)
          .where(inArray(documents.id, ids.slice(start, start + ID_CHUNK)))
          .all(),
      );
    return rows.filter((row) => row.status === 'archived' || row.status === 'indexed_only');
  }

  /** How many of the documents may go to the LLM and roughly how many tokens that is (the stored text is what is sent). */
  estimate(ids: string[]): BulkEstimate {
    const { privacy, llm, settings } = this.deps;
    const maxChars = settings.get().llm.maxInputChars;
    const rows = this.archivedRows(ids);
    const eligible = llm.isConfigured() ? rows.filter((row) => privacy.evaluateDocument(row).allowed) : [];
    const chars = eligible.reduce((sum, row) => sum + Math.min(row.extractedText.length, maxChars) + PROMPT_OVERHEAD_CHARS, 0);
    return { total: rows.length, llmEligible: eligible.length, estimatedTokens: estimateTokens(chars) };
  }

  enqueue(request: { ids: string[]; reread: boolean; reanalyze: boolean; confirmLlm: boolean }): Job {
    const rows = this.archivedRows([...new Set(request.ids)]);
    if (rows.length === 0) throw validationError('Es sind keine archivierten Dokumente ausgewählt.');
    if (!request.reread && !request.reanalyze) throw validationError('Bitte wähle, was neu verarbeitet werden soll.');
    const allowLlm = request.reanalyze && (this.deps.privacy.mode() === 'auto' || request.confirmLlm);
    const payload: ReprocessPayload = { documentIds: rows.map((row) => row.id), reread: request.reread, reanalyze: request.reanalyze, allowLlm };
    return this.deps.jobs.enqueue(DOCUMENT_REPROCESS_JOB, { label: `Verarbeite ${rows.length} Dokument(e) neu`, payload });
  }

  async run(job: JobContext<ReprocessPayload>): Promise<{ summary: string }> {
    const { documentIds: ids } = job.payload;
    const saved = (job.checkpoint ?? {}) as Partial<ReprocessProgress>;
    const progress: ReprocessProgress = { next: saved.next ?? 0, done: saved.done ?? 0, failed: saved.failed ?? 0, proposals: saved.proposals ?? 0 };
    const started = Date.now();
    const resumedAt = progress.next;
    for (; progress.next < ids.length; progress.next += 1) {
      job.throwIfCancelled();
      const outcome = await this.process(ids[progress.next]!, job);
      if (outcome === 'failed') progress.failed += 1;
      else progress.done += 1;
      if (outcome === 'proposed') progress.proposals += 1;
      job.saveCheckpoint({ ...progress, next: progress.next + 1 });
      const handled = progress.next + 1;
      job.report(
        handled / ids.length,
        progressLine({ done: handled, total: ids.length, elapsedMs: Date.now() - started, sampled: handled - resumedAt, verb: 'neu verarbeitet' }),
      );
    }
    return this.finish(progress);
  }

  private async process(id: string, job: JobContext<ReprocessPayload>): Promise<'proposed' | 'processed' | 'failed'> {
    const { documents: access, jobs, ctx } = this.deps;
    const { reread, reanalyze, allowLlm } = job.payload;
    try {
      if (reread) await access.rereadArchived(id, { signal: job.signal });
      else if (!reanalyze) await access.indexDocument(id);
      if (!reanalyze) return 'processed';
      await untilSettled((attempt) => access.reanalysis.propose(id, { allowLlm, signal: job.signal, llmAttempt: attempt }), {
        backoffMs: (failed) => jobs.backoffMs(failed),
        signal: job.signal,
        onWait: (message) => job.report(null, message),
      });
      return 'proposed';
    } catch (err) {
      if (isJobCancelled(err)) throw err;
      ctx.logger.warn('documents', 'Re-processing failed', { documentId: id, error: err });
      return 'failed';
    }
  }

  /** One notification for the whole run, with a link to the documents when there are proposals to look at. */
  private finish(progress: ReprocessProgress): { summary: string } {
    const summary = runSummary({ done: progress.done, failed: progress.failed, verb: 'neu verarbeitet' });
    const proposals = progress.proposals === 0 ? '' : ` ${progress.proposals} Vorschläge für neue Metadaten warten in den Dokumenten auf deine Prüfung.`;
    this.deps.notifications.create({
      title: 'Neuverarbeitung abgeschlossen',
      description: `${summary}.${proposals}`,
      type: 'system',
      priority: progress.failed > 0 ? 'normal' : 'low',
      proposedActions: [{ label: 'Dokumente öffnen', kind: 'navigate', target: '/documents/' }],
    });
    return { summary };
  }
}
