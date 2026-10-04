import type { DocumentStatus } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import { documents } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import { LLM_ANALYSIS_ATTEMPTS } from './analysis-retry';
import { documentsWithActiveJobs } from './document-analysis';
import { DOCUMENT_ANALYZE_BATCH_JOB, type AnalyzeBatchPayload } from './document-batch';
import type { DocRow, DocumentDeps } from './document-model';
import type { UndoService } from './undo';

export const DOCUMENT_STATUS_UNDO = 'document_status';
const IGNORE_ACTIONS = ['document.ignore', 'archive.ignore'];

interface DocumentStatusUndo {
  id: string;
  previousStatus: DocumentStatus;
  previousArchiveMode: string | null;
  afterUpdatedAt: string;
}

/** Ignoring a document and taking it back into the inbox; both are undoable. */
export class DocumentIgnore {
  constructor(private readonly deps: DocumentDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  registerUndo(undo: UndoService): void {
    undo.register(DOCUMENT_STATUS_UNDO, {
      check: async (data) => this.conflicts(data as DocumentStatusUndo),
      run: async (data) => this.revert(data as DocumentStatusUndo),
    });
  }

  /** Marks an inbox document as ignored; `auditId` is its undo entry. */
  ignore(id: string): { auditId: string } {
    const row = this.deps.documents.getRow(id);
    if (row.status === 'archived') throw new AppError('validation_error', 'Archivierte Dokumente können nicht ignoriert werden.');
    return { auditId: this.changeStatus(row, { action: 'document.ignore', status: 'ignored', archiveMode: 'ignore' }) };
  }

  /** Takes an ignored document back: undoes the ignoring, or (scanner exclusion) restores the state its proposal implies. */
  async restore(id: string, undo: UndoService): Promise<void> {
    const row = this.deps.documents.getRow(id);
    if (row.status !== 'ignored') throw new AppError('validation_error', 'Das Dokument ist nicht ignoriert.');
    const entry = this.deps.audit.list({ entityId: id, onlyUndoable: true, limit: 50 }).find((e) => IGNORE_ACTIONS.includes(e.action));
    if (entry && (await undo.undo(entry.id)).undone) return;
    // no undo entry, or the document changed since: the logged restore to the state its proposal implies
    this.changeStatus(row, { action: 'document.unignore', status: row.proposal ? 'proposed' : 'staged', archiveMode: null });
    this.requeueAnalysis(id);
  }

  private changeStatus(row: DocRow, change: { action: string; status: DocumentStatus; archiveMode: string | null }): string {
    const updatedAt = nowIso();
    this.db.update(documents).set({ status: change.status, archiveMode: change.archiveMode, updatedAt }).where(eq(documents.id, row.id)).run();
    const undo: DocumentStatusUndo = {
      id: row.id,
      previousStatus: row.status as DocumentStatus,
      previousArchiveMode: row.archiveMode,
      afterUpdatedAt: updatedAt,
    };
    const auditId = this.deps.audit.log({
      action: change.action,
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [row.id],
      before: { status: row.status },
      after: { status: change.status },
      undo: { type: DOCUMENT_STATUS_UNDO, data: undo },
    });
    this.deps.ctx.events.changed('documents', 'status');
    return auditId;
  }

  private conflicts(data: DocumentStatusUndo): string[] {
    const row = this.db.select().from(documents).where(eq(documents.id, data.id)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    return row.updatedAt === data.afterUpdatedAt ? [] : ['Das Dokument wurde seit der Änderung erneut verändert.'];
  }

  private revert(data: DocumentStatusUndo): string {
    this.db
      .update(documents)
      .set({ status: data.previousStatus, archiveMode: data.previousArchiveMode, updatedAt: nowIso() })
      .where(eq(documents.id, data.id))
      .run();
    this.requeueAnalysis(data.id);
    this.deps.ctx.events.changed('documents', 'status');
    return 'Status des Dokuments wiederhergestellt.';
  }

  /** A document back in `staged` without a proposal (its analysis was skipped while ignored) is queued for analysis like a single import. */
  private requeueAnalysis(id: string): void {
    const row = this.deps.documents.getRow(id);
    if (row.status !== 'staged' || row.proposal || this.analysisQueued(id)) return;
    this.deps.jobs.enqueue('document.analyze', {
      label: `Analysiere ${row.originalName}`,
      payload: { documentId: id, allowLlm: this.deps.privacy.mode() === 'auto' },
      maxAttempts: LLM_ANALYSIS_ATTEMPTS,
    });
  }

  private analysisQueued(id: string): boolean {
    const batches = this.deps.jobs.activePayloads<AnalyzeBatchPayload>(DOCUMENT_ANALYZE_BATCH_JOB);
    return documentsWithActiveJobs(this.deps).has(id) || batches.some((batch) => batch.documentIds.includes(id));
  }
}
