import { maskingOf } from '../util/redact';
import path from 'node:path';
import { DocumentClassification, type DocumentProposal, type LlmStatus } from '@archivist/shared';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { documents, scanFiles } from '../db/schema';
import type { ParsedDocument } from '../parsers/parsed-document';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import { isTokenCapError } from '../util/token-cap';
import { LlmAnalysisRetry, mayRetryLlm } from './analysis-retry';
import { classifyLocally } from './classifier';
import { classificationRequest, mergeLlmClassification, type Classification, type KnownSubjects } from './document-classification';
import { MAX_LLM_PARTS, cutKeepsMasking, mergeParts, partSize, splitIntoParts } from './document-parts';
import { ARCHIVED_STATUSES, extractFile, extractedColumns, type DocRow, type DocumentDeps } from './document-model';
import { isJobCancelled, isJobInterrupted } from './jobs';
import type { PrivacyDecision } from './privacy';

export const QUARANTINE_NOT_ANALYZED = 'Dateien in Quarantäne werden nicht analysiert. Wähle zuerst „Trotzdem importieren“.';
const INTERRUPTED_ANALYSIS_REASON = 'Die Analyse wurde unterbrochen (z. B. weil Archivist beendet wurde). Bitte „Erneut verarbeiten“ wählen.';
const CANCELLED_ANALYSIS_REASON = 'Die Analyse wurde abgebrochen. Bitte „Erneut verarbeiten“ wählen.';

export interface AnalyzeOptions {
  allowLlm: boolean;
  /** Cancels the analysis at the next checkpoint (and a running LLM request); the document is then marked as cancelled. */
  signal?: AbortSignal;
  /** On an error, leave the document in `analyzing` for callers that retry; they call `markAnalysisFailed` at the end. */
  deferFailure?: boolean;
  /** Number of this attempt (1-based) of a job that retries: a retryable LLM error then asks for a re-run instead of the local fallback (#220). */
  llmAttempt?: number;
  /** No "Klassifikation bereit" notification: a bulk run reports once at its end. */
  quiet?: boolean;
}

export type AnalysisResult = { usedLlm: boolean; warning: string | null; skipped?: true };

export interface ClassifiedText {
  classification: Classification;
  usedLlm: boolean;
  warning: string | null;
  /** What the LLM read of the text: characters and requests (both 0 without LLM). */
  read: { chars: number; parts: number };
}

const NOTHING_READ = { chars: 0, parts: 0 };

const skipped = (): AnalysisResult => ({ usedLlm: false, warning: null, skipped: true });

/** LLM status after an analysis; a folder lock alone must not turn into a sticky per-document exclusion. */
function llmStatusAfter(row: DocRow, outcome: { usedLlm: boolean; decision: PrivacyDecision }): LlmStatus {
  if (outcome.usedLlm) return 'analyzed';
  if (outcome.decision.allowed) return 'pending';
  const folderLockOnly = !row.folderLlmAllowed && row.llmStatus !== 'excluded';
  return outcome.decision.status === 'excluded' && folderLockOnly ? 'local_only' : (outcome.decision.status ?? 'local_only');
}

/** Content analysis: extract locally, optionally classify via LLM, propose a target folder – the file is not touched. */
export class DocumentAnalyzer {
  constructor(private readonly deps: DocumentDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async analyze(id: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
    const row = this.deps.documents.getRow(id);
    if (row.status === 'quarantined') throw new AppError('validation_error', QUARANTINE_NOT_ANALYZED);
    // Claim the document atomically: an archived or index-only document (e.g. archived while queued) stays untouched.
    const claimed = this.db
      .update(documents)
      .set({ status: 'analyzing', updatedAt: nowIso() })
      .where(and(eq(documents.id, id), notInArray(documents.status, ARCHIVED_STATUSES)))
      .run();
    if (!claimed.changes) {
      this.deps.ctx.logger.info('documents', 'Analysis skipped: document is already archived', { documentId: id, status: row.status });
      return skipped();
    }
    this.deps.ctx.events.changed('documents');
    try {
      return await this.runAnalysis(row, opts);
    } catch (err) {
      return this.afterFailure(row, { err, opts });
    }
  }

  /** What a failed analysis leaves behind: a retry waits, a paused or cancelled run keeps the document, any other error marks it failed. */
  private afterFailure(row: DocRow, failure: { err: unknown; opts: AnalyzeOptions }): AnalysisResult {
    const { err, opts } = failure;
    const id = row.id;
    if (err instanceof LlmAnalysisRetry || (isTokenCapError(err) && !opts.deferFailure)) {
      this.restoreStatus(row); // a retry waits for the re-run, a bulk run paused by the token limit leaves the document untouched
      throw err;
    }
    if (isJobCancelled(err)) {
      // interrupted on quit: the document stays `analyzing`, its job runs again after the next start
      if (!isJobInterrupted(err)) this.markAnalysisCancelled(id);
      throw err;
    }
    // Never leave a document stuck in `analyzing`. If it was archived meanwhile, the failure is irrelevant.
    if (opts.deferFailure ? this.isAnalyzing(id) : this.markAnalysisFailed(id, err)) throw err;
    this.deps.ctx.logger.info('documents', 'Analysis error ignored: document status has changed meanwhile', { documentId: id, error: err });
    return skipped();
  }

  private restoreStatus(row: DocRow): void {
    this.db
      .update(documents)
      .set({ status: row.status, updatedAt: nowIso() })
      .where(and(eq(documents.id, row.id), eq(documents.status, 'analyzing')))
      .run();
    this.deps.ctx.events.changed('documents', 'status');
  }

  private isAnalyzing(id: string): boolean {
    return this.db.select({ status: documents.status }).from(documents).where(eq(documents.id, id)).get()?.status === 'analyzing';
  }

  /** A cancelled analysis leaves `analyzing` as `failed` with a reason (no notification: the user cancelled it). */
  markAnalysisCancelled(id: string): boolean {
    return this.markFailed(id, CANCELLED_ANALYSIS_REASON);
  }

  /** Marks a document still in `analyzing` as `failed` (with reason), so the inbox offers „Erneut verarbeiten“. */
  markAnalysisFailed(id: string, err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return this.markFailed(id, `Analyse fehlgeschlagen: ${message}`);
  }

  private markFailed(id: string, reason: string): boolean {
    const result = this.db
      .update(documents)
      .set({ status: 'failed', processingStatus: 'failed', processingError: reason, updatedAt: nowIso() })
      .where(and(eq(documents.id, id), eq(documents.status, 'analyzing')))
      .run();
    if (result.changes) this.deps.ctx.events.changed('documents', 'status');
    return result.changes > 0;
  }

  /** Startup recovery: documents left in `analyzing` that no job will pick up again become `failed`; returns how many. */
  recoverInterruptedAnalyses(): number {
    const stuck = this.db.select({ id: documents.id }).from(documents).where(eq(documents.status, 'analyzing')).all();
    if (!stuck.length) return 0;
    const covered = this.documentsWithActiveJobs();
    const orphaned = stuck.map((d) => d.id).filter((id) => !covered.has(id));
    if (!orphaned.length) return 0;
    this.db
      .update(documents)
      .set({ status: 'failed', processingStatus: 'failed', processingError: INTERRUPTED_ANALYSIS_REASON, updatedAt: nowIso() })
      .where(and(inArray(documents.id, orphaned), eq(documents.status, 'analyzing')))
      .run();
    this.deps.ctx.logger.info('documents', 'Reset interrupted analyses', { count: orphaned.length });
    this.deps.ctx.events.changed('documents', 'status');
    return orphaned.length;
  }

  private documentsWithActiveJobs(): Set<string | undefined> {
    const { jobs } = this.deps;
    const covered = new Set(jobs.activePayloads<{ documentId?: string }>('document.analyze').map((p) => p.documentId));
    const fileIds = jobs.activePayloads<{ fileIds?: string[] }>('scanner.analyze').flatMap((p) => p.fileIds ?? []);
    if (fileIds.length)
      for (const f of this.db.select({ documentId: scanFiles.documentId }).from(scanFiles).where(inArray(scanFiles.id, fileIds)).all())
        covered.add(f.documentId ?? undefined);
    return covered;
  }

  private knownNames(type: 'topic' | 'project', opts: { confirmedOnly?: boolean } = {}): string[] {
    return this.deps.graph.entityNames({ type, ...opts });
  }

  private async runAnalysis(row: DocRow, opts: AnalyzeOptions): Promise<AnalysisResult> {
    const { signal } = opts;
    const file = this.deps.documents.readablePath(row);
    signal?.throwIfAborted();
    const parsed = await extractFile(this.deps, file);
    signal?.throwIfAborted();
    const { classified, decision } = await this.classifyText(row, { text: parsed.text, opts, privacyRow: { ...row, sourcePath: row.sourcePath ?? file } });
    signal?.throwIfAborted(); // last checkpoint: after this the proposal is stored
    return this.storeProposal(row, { parsed, classified, decision, quiet: opts.quiet ?? false });
  }

  /** Local classification of a text, refined by the LLM when the privacy rules and the options allow it. */
  async classifyText(
    row: DocRow,
    input: { text: string; opts: AnalyzeOptions; privacyRow?: DocRow },
  ): Promise<{ classified: ClassifiedText; decision: PrivacyDecision }> {
    const { text, opts } = input;
    const decision = this.deps.privacy.evaluateDocument(input.privacyRow ?? row);
    const canUseLlm = opts.allowLlm && decision.allowed && this.deps.llm.isConfigured() && text.trim().length > 0;
    const known: KnownSubjects = { topics: this.knownNames('topic'), projects: this.knownNames('project') };
    const local: Classification = {
      ...classifyLocally({
        fileName: row.originalName,
        ext: row.ext,
        text,
        knownTopics: known.topics,
        knownProjects: known.projects,
        folderName: row.sourcePath ? path.basename(path.dirname(row.sourcePath)) : '',
      }),
      fileNameHint: null,
    };
    const classified = canUseLlm
      ? await this.classifyWithLlm(row, { local, text, known, signal: opts.signal, attempt: opts.llmAttempt })
      : { classification: local, usedLlm: false, warning: null, read: NOTHING_READ };
    return { classified, decision };
  }

  /** Falls back to the local classification (with a warning) when the LLM request fails for good; a retryable failure asks for a re-run first. */
  private async classifyWithLlm(
    row: DocRow,
    input: { local: Classification; text: string; known: KnownSubjects; signal?: AbortSignal; attempt?: number },
  ): Promise<ClassifiedText> {
    const { local, text, known, signal } = input;
    try {
      const { results, read } = await this.classifyInParts(row, { text, signal });
      const merged = mergeParts(results);
      return { classification: mergeLlmClassification(local, { result: merged, text, known }), usedLlm: true, warning: null, read };
    } catch (err) {
      signal?.throwIfAborted(); // a cancelled request is no LLM problem – stop instead of falling back
      if (isTokenCapError(err)) throw err; // the daily token limit pauses the job instead of degrading the proposal
      if (mayRetryLlm(err, input.attempt)) throw new LlmAnalysisRetry(err);
      const warning = `LLM-Analyse nicht möglich: ${err instanceof Error ? err.message : String(err)} – lokale Klassifikation verwendet.`;
      this.deps.ctx.logger.warn('documents', 'LLM classification failed', { documentId: row.id, error: err });
      this.deps.notifications.create({
        title: 'LLM-Analyse fehlgeschlagen',
        description: warning,
        type: 'system',
        priority: 'normal',
        proposedActions: [{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }],
        dedupeKey: `llm-error:${Math.floor(Date.now() / 600_000)}`,
      });
      return { classification: local, usedLlm: false, warning, read: NOTHING_READ };
    }
  }

  /** A long text is read in consecutive parts, each its own checked, masked and logged request; a failing later part keeps what was read so far. */
  private async classifyInParts(
    row: DocRow,
    input: { text: string; signal?: AbortSignal },
  ): Promise<{ results: [DocumentClassification, ...DocumentClassification[]]; read: ClassifiedText['read'] }> {
    const { text, signal } = input;
    const confirmed = { topics: this.knownNames('topic', { confirmedOnly: true }), projects: this.knownNames('project', { confirmedOnly: true }) };
    const context = { mainCategories: this.deps.categories.mainCategories(), confirmed };
    const promptChars = classificationRequest(row, { ...context, text: '', part: { number: MAX_LLM_PARTS, of: MAX_LLM_PARTS } }).input.length;
    const masking = maskingOf(this.deps.settings.get());
    const parts = splitIntoParts(text, partSize({ maxInputChars: this.deps.settings.get().llm.maxInputChars, promptChars }), (whole, position) =>
      cutKeepsMasking(whole, position, masking),
    );
    const complete = (part: string, number: number) =>
      this.deps.llm.completeJson(DocumentClassification, {
        ...classificationRequest(row, { ...context, text: part, part: parts.length > 1 ? { number, of: parts.length } : undefined }),
        signal,
      });
    const results: [DocumentClassification, ...DocumentClassification[]] = [await complete(parts[0]!, 1)];
    let chars = parts[0]!.length;
    for (const [index, part] of parts.slice(1).entries()) {
      signal?.throwIfAborted();
      try {
        results.push(await complete(part, index + 2));
        chars += part.length;
      } catch (err) {
        signal?.throwIfAborted();
        if (isTokenCapError(err)) throw err;
        this.deps.ctx.logger.warn('documents', 'LLM analysis of a later part failed', { documentId: row.id, part: index + 2, error: err });
        break;
      }
    }
    return { results, read: { chars, parts: results.length } };
  }

  private async storeProposal(
    row: DocRow,
    result: { parsed: ParsedDocument; classified: ClassifiedText; decision: PrivacyDecision; quiet: boolean },
  ): Promise<AnalysisResult> {
    const { usedLlm, warning, read } = result.classified;
    const c = result.classified.classification;
    const columns = extractedColumns(result.parsed);
    const proposal: DocumentProposal = {
      location: {
        categoryPath: c.categoryPath,
        fileName: c.fileNameHint,
        newMainCategory: Boolean(this.deps.categories.needsApproval(c.categoryPath)),
        rationale: c.rationale,
        confidence: c.confidence,
      },
      topic: c.topic,
      project: c.project,
      persons: c.persons,
      tags: c.tags,
      possibleDecisions: c.possibleDecisions,
      possibleOpenItems: c.possibleOpenItems,
      duplicateOfDocumentId: this.textDuplicateOf(row.id, columns.textHash),
      analyzedBy: usedLlm ? 'llm' : 'local',
      coverage: { textChars: result.parsed.text.length, llmChars: read.chars, llmParts: read.parts, extractionTruncated: result.parsed.truncated },
    };
    const title = c.title.slice(0, 200);
    // document, graph node and notice change together: a failure in between leaves none of them
    const stored = this.deps.ctx.database.transaction(() => {
      const written = this.db
        .update(documents)
        .set({
          title,
          docType: c.docType,
          summary: c.summary,
          categoryPath: c.categoryPath,
          persons: this.deps.persons.resolveNames(c.persons, { context: 'document', create: false }).names,
          tags: c.tags,
          dates: c.dates,
          documentDate: c.documentDate,
          confidence: c.confidence,
          ...columns,
          proposal,
          llmStatus: llmStatusAfter(row, { usedLlm, decision: result.decision }),
          status: 'proposed',
          updatedAt: nowIso(),
        })
        // Only write the proposal if nobody archived (or ignored) the document while it was being analyzed.
        .where(and(eq(documents.id, row.id), eq(documents.status, 'analyzing')))
        .run();
      if (!written.changes) return false;
      this.deps.nearDuplicates.record(row.id, result.parsed.text);
      this.deps.graph.registerNode({ type: 'document', id: row.id, name: title, description: c.summary });
      if (!result.quiet)
        this.deps.notifications.create({
          title: 'Klassifikation bereit',
          description: `„${c.title}“ → ${c.categoryPath} (${Math.round(c.confidence * 100)} % sicher)`,
          type: 'classification_ready',
          priority: 'low',
          affectedEntityIds: [row.id],
          proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
          dedupeKey: `classified:${row.id}`,
        });
      return true;
    });
    if (!stored) {
      this.deps.ctx.logger.info('documents', 'Analysis result discarded: document status changed in the meantime', { documentId: row.id });
      return { usedLlm, warning, skipped: true };
    }
    this.deps.ctx.events.changed('documents', 'knowledge', 'status');
    return { usedLlm, warning };
  }

  /** Indexed lookup of a document with the same text instead of reading every document's metadata (#212). */
  private textDuplicateOf(id: string, textHash: string | null): string | null {
    if (!textHash) return null;
    const duplicate = this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.textHash, textHash), ne(documents.id, id), inArray(documents.status, ['archived', 'indexed_only', 'proposed'])))
      .get();
    return duplicate?.id ?? null;
  }
}
