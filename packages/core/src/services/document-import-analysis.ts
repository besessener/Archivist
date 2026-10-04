import type { BulkEstimate, Job } from '@archivist/shared';
import { inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { permissionError, validationError } from '../util/errors';
import { estimateAnalysisTokens } from './bulk-estimate';
import { DOCUMENT_ANALYZE_BATCH_JOB, type AnalyzeBatchPayload } from './document-batch';
import type { JobQueueService } from './jobs';
import type { LlmService } from './llm';
import type { PrivacyService } from './privacy';
import type { SettingsService } from './settings';

const ID_CHUNK = 500;
/** Documents still in the inbox; archived or trashed ones are no longer analysed. */
const INBOX_STATUSES = ['staged', 'proposed', 'failed'];

export interface ImportAnalysisDeps {
  ctx: AppContext;
  jobs: JobQueueService;
  privacy: PrivacyService;
  settings: SettingsService;
  llm: LlmService;
}

/** „Alle N mit KI analysieren“ after an import that was analysed locally: the same documents again, with one consent. */
export class ImportAnalysis {
  constructor(private readonly deps: ImportAnalysisDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** The import's documents that still wait in the inbox and were not analysed with the LLM yet (id, privacy fields and text length only). */
  private rows(jobId: string) {
    const payload = this.deps.jobs.payloadOf<AnalyzeBatchPayload>(jobId);
    if (!payload?.documentIds) throw validationError('Zu dieser Meldung gibt es keinen Import mehr.');
    const rows = [];
    for (let start = 0; start < payload.documentIds.length; start += ID_CHUNK)
      rows.push(
        ...this.db
          .select({
            id: documents.id,
            status: documents.status,
            sourcePath: documents.sourcePath,
            ext: documents.ext,
            llmStatus: documents.llmStatus,
            folderLlmAllowed: documents.folderLlmAllowed,
            textLength: sql<number>`length(${documents.extractedText})`,
          })
          .from(documents)
          .where(inArray(documents.id, payload.documentIds.slice(start, start + ID_CHUNK)))
          .all(),
      );
    return rows.filter((row) => INBOX_STATUSES.includes(row.status) && row.llmStatus !== 'analyzed');
  }

  /** How many of the import's documents wait for the LLM, how many may go there and roughly how many tokens. */
  estimate(jobId: string): BulkEstimate {
    const { privacy, llm, settings } = this.deps;
    const rows = this.rows(jobId);
    const eligible = llm.isConfigured() ? rows.filter((row) => privacy.evaluateDocument(row).allowed) : [];
    const estimatedTokens = estimateAnalysisTokens(
      eligible.map((row) => row.textLength),
      settings.get().llm.maxInputChars,
    );
    return { total: rows.length, llmEligible: eligible.length, estimatedTokens };
  }

  /** Queues the batch analysis with the LLM for the documents the privacy rules allow; a second click returns the run that is already queued. */
  enqueue(request: { jobId: string; confirmLlm: boolean }): Job {
    const { privacy, llm, jobs } = this.deps;
    if (!request.confirmLlm) throw permissionError('Die Analyse mit KI erfordert deine ausdrückliche Zustimmung.');
    if (privacy.mode() === 'local_only') throw permissionError('Dein Datenschutzmodus ist „Nur lokal“ – es wird nichts an die KI gesendet.');
    if (!llm.isConfigured()) throw validationError('Es ist noch kein KI-Dienst eingerichtet.');
    const ids = this.rows(request.jobId)
      .filter((row) => privacy.evaluateDocument(row).allowed)
      .map((row) => row.id);
    if (ids.length === 0)
      throw validationError('Alle Dokumente dieses Imports sind schon mit KI analysiert, archiviert, entfernt oder von der KI ausgeschlossen.');
    const payload: AnalyzeBatchPayload = {
      documentIds: ids,
      allowLlm: true,
      duplicates: 0,
      rejected: 0,
      title: 'Analyse mit KI abgeschlossen',
      sourceJobId: request.jobId,
    };
    return jobs.enqueue(DOCUMENT_ANALYZE_BATCH_JOB, {
      label: `Analysiere ${ids.length} Dokumente mit KI`,
      payload,
      maxAttempts: 1,
      sameAs: (active: AnalyzeBatchPayload) => active.sourceJobId === request.jobId && active.allowLlm,
    });
  }
}
