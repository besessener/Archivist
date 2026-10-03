import type { DocumentRecord, ReanalysisProposal } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import { documentReanalysis } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { AnalyzeOptions, DocumentAnalyzer } from './document-analysis';
import type { DocumentMetadataEditor } from './document-metadata';
import { isArchivedStatus, type DocumentDeps } from './document-model';

type StoredProposal = Omit<ReanalysisProposal, 'documentId' | 'createdAt'>;

/** Metadata-only re-analysis of archived documents (#220): a proposal is stored, nothing is changed until the user applies it. */
export class DocumentReanalysis {
  constructor(
    private readonly deps: DocumentDeps,
    private readonly parts: { analyzer: DocumentAnalyzer; metadata: DocumentMetadataEditor },
  ) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Classifies the stored text again (the file is not read, not moved) and keeps the result as a proposal. */
  async propose(id: string, opts: AnalyzeOptions): Promise<ReanalysisProposal> {
    const row = this.deps.documents.getRow(id);
    if (!isArchivedStatus(row.status))
      throw new AppError(
        'validation_error',
        'Nur archivierte oder nur indexierte Dokumente werden neu analysiert; Dokumente im Eingang kannst du neu verarbeiten.',
      );
    if (!row.extractedText.trim()) throw new AppError('validation_error', 'Zu diesem Dokument ist kein Text gespeichert. Lies es zuerst neu ein.');
    const { classified } = await this.parts.analyzer.classifyText(row, { text: row.extractedText, opts });
    const c = classified.classification;
    const stored: StoredProposal = {
      title: c.title.slice(0, 200),
      docType: c.docType,
      summary: c.summary,
      documentDate: c.documentDate,
      topic: c.topic,
      project: c.project,
      persons: c.persons,
      tags: c.tags,
      analyzedBy: classified.usedLlm ? 'llm' : 'local',
    };
    const createdAt = nowIso();
    this.db
      .insert(documentReanalysis)
      .values({ documentId: id, proposal: stored, createdAt })
      .onConflictDoUpdate({ target: documentReanalysis.documentId, set: { proposal: stored, createdAt } })
      .run();
    this.deps.ctx.events.changed('documents');
    return { ...stored, documentId: id, createdAt };
  }

  /** Applies the proposal to the metadata of an archived document; requires the user's confirmation (level 2). */
  apply(id: string, { confirmed }: { confirmed: boolean }): DocumentRecord {
    if (!confirmed) throw new AppError('permission_error', 'Das Übernehmen neuer Metadaten erfordert eine Bestätigung.');
    const proposal = this.get(id);
    if (!proposal) throw new AppError('validation_error', 'Zu diesem Dokument liegt kein Vorschlag vor.');
    return this.parts.metadata.applyReanalysis(id, proposal);
  }

  get(id: string): ReanalysisProposal | null {
    const row = this.db.select().from(documentReanalysis).where(eq(documentReanalysis.documentId, id)).get();
    return row ? { ...(row.proposal as unknown as StoredProposal), documentId: row.documentId, createdAt: row.createdAt } : null;
  }

  pendingIds(): string[] {
    return this.db
      .select({ id: documentReanalysis.documentId })
      .from(documentReanalysis)
      .all()
      .map((row) => row.id);
  }

  discard(id: string): void {
    this.db.delete(documentReanalysis).where(eq(documentReanalysis.documentId, id)).run();
    this.deps.ctx.events.changed('documents');
  }
}
