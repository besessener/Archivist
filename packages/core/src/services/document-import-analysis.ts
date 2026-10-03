import type { BulkEstimate, Job } from '@archivist/shared';
import { inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { permissionError, validationError } from '../util/errors';
import { estimateTokens } from '../util/estimate-tokens';
import { DOCUMENT_ANALYZE_BATCH_JOB, type AnalyzeBatchPayload } from './document-batch';
import type { JobQueueService } from './jobs';
import type { LlmService } from './llm';
import type { PrivacyService } from './privacy';
import type { SettingsService } from './settings';

/** Characters the instructions of one analysis request add to the text. */
const PROMPT_OVERHEAD_CHARS = 2_000;
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

  private rows(jobId: string) {
    const payload = this.deps.jobs.payloadOf<AnalyzeBatchPayload>(jobId);
    if (!payload?.documentIds) throw validationError('Zu dieser Meldung gibt es keinen Import mehr.');
    const rows = [];
    for (let start = 0; start < payload.documentIds.length; start += ID_CHUNK)
      rows.push(
        ...this.db
          .select()
          .from(documents)
          .where(inArray(documents.id, payload.documentIds.slice(start, start + ID_CHUNK)))
          .all(),
      );
    return rows.filter((row) => INBOX_STATUSES.includes(row.status));
  }

  /** How many of the import's documents still wait in the inbox, how many may go to the LLM and roughly how many tokens. */
  estimate(jobId: string): BulkEstimate {
    const { privacy, llm, settings } = this.deps;
    const maxChars = settings.get().llm.maxInputChars;
    const rows = this.rows(jobId);
    const eligible = llm.isConfigured() ? rows.filter((row) => privacy.evaluateDocument(row).allowed) : [];
    const chars = eligible.reduce((sum, row) => sum + Math.min(row.extractedText.length, maxChars) + PROMPT_OVERHEAD_CHARS, 0);
    return { total: rows.length, llmEligible: eligible.length, estimatedTokens: estimateTokens(chars) };
  }

  /** Queues the batch analysis with the LLM; the privacy rules still decide per document what may be sent. */
  enqueue(jobId: string): Job {
    if (this.deps.privacy.mode() === 'local_only') throw permissionError('Dein Datenschutzmodus ist „Nur lokal“ – es wird nichts an die KI gesendet.');
    if (!this.deps.llm.isConfigured()) throw validationError('Es ist noch kein KI-Dienst eingerichtet.');
    const ids = this.rows(jobId).map((row) => row.id);
    if (ids.length === 0) throw validationError('Alle Dokumente dieses Imports sind schon archiviert oder entfernt.');
    const payload: AnalyzeBatchPayload = { documentIds: ids, allowLlm: true, duplicates: 0, rejected: 0, title: 'Analyse mit KI abgeschlossen' };
    return this.deps.jobs.enqueue(DOCUMENT_ANALYZE_BATCH_JOB, { label: `Analysiere ${ids.length} Dokumente mit KI`, payload, maxAttempts: 1 });
  }
}
