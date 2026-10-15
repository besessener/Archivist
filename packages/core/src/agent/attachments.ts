import type { AppContext } from '../context';
import type { ModelImage } from '../parsers/model-image';
import { extractFile, type DocRow } from '../services/document-model';
import type { DocumentService } from '../services/documents';
import type { PrivacyService } from '../services/privacy';
import type { SettingsService } from '../services/settings';
import { maskingOf } from '../util/redact';
import type { WorkerPool } from '../workers/pool';
import type { RefStore } from './registry';
import { asData, findInstruction, maskSecrets } from './security';
import { SECTION_CHARS } from './tools/read-documents';
import type { AgentAttachment } from './types';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

export interface AttachmentReaderDeps {
  ctx: AppContext;
  settings: SettingsService;
  pool: WorkerPool;
  docs: DocumentService;
  privacy: PrivacyService;
}

/** What the attachments of one message add to the agent's run. */
export interface PreparedAttachments {
  attachments: AgentAttachment[];
  images: Map<string, ModelImage>;
  /** Documents whose content goes to the model with the message (transmission log, replay filter). */
  shared: string[];
  redactions: number;
  personalRedactions: number;
  /** First instruction-like passage in an attachment's text: the run is tainted like by a tool result. */
  instruction: string | null;
}

const kilobytes = (size: number) => `${Math.max(1, Math.round(size / 1024))} KB`;

/** Reads what the user attached to a chat message: its text and, for images, the picture – only what the privacy rules release. */
export class AttachmentReader {
  constructor(private readonly deps: AttachmentReaderDeps) {}

  async prepare(ids: string[], refs: RefStore): Promise<PreparedAttachments> {
    const prepared: PreparedAttachments = { attachments: [], images: new Map(), shared: [], redactions: 0, personalRedactions: 0, instruction: null };
    for (const id of ids) {
      const row = this.deps.docs.findRow(id);
      if (row) await this.add(row, { refs, prepared });
    }
    return prepared;
  }

  private async add(row: DocRow, { refs, prepared }: { refs: RefStore; prepared: PreparedAttachments }): Promise<void> {
    const ref = refs.doc(row.id);
    // the user attached it themselves: that releases it for this message, but never past an exclusion
    if (!this.deps.privacy.evaluateDocument(row).allowed) {
      prepared.attachments.push({ documentId: row.id, ref, text: `Angehängt: ${ref} [nicht freigegeben] (.${row.ext})`, image: false });
      return;
    }
    const text = await this.textOf(row);
    const part = text.slice(0, SECTION_CHARS);
    prepared.instruction ??= findInstruction(part);
    const more =
      text.length > SECTION_CHARS ? `\nDas ist der Anfang (${SECTION_CHARS} von ${text.length} Zeichen); weitere Abschnitte liest read_document.` : '';
    const body = part.trim() ? asData(ref, part) : '(kein Text erkannt)';
    const masked = maskSecrets(
      `Angehängt: ${ref} „${row.originalName}“ (.${row.ext}, ${kilobytes(row.size)})\n${body}${more}`,
      maskingOf(this.deps.settings.get()),
    );
    prepared.redactions += masked.count;
    prepared.personalRedactions += masked.personalData;
    const image = IMAGE_EXTENSIONS.has(row.ext) ? await this.imageOf(row) : null;
    if (image) prepared.images.set(row.id, image);
    prepared.attachments.push({ documentId: row.id, ref, text: masked.text, image: image !== null });
    prepared.shared.push(row.id);
  }

  /** The stored text, else read now: a file attached right after its import is usually not analysed yet. */
  private async textOf(row: DocRow): Promise<string> {
    if (row.extractedText.trim() || row.processingStatus !== 'pending') return row.extractedText;
    try {
      return (await extractFile(this.deps, this.deps.docs.readablePath(row))).text;
    } catch (error) {
      this.deps.ctx.logger.warn('agent', 'Attachment text could not be read', { documentId: row.id, error });
      return '';
    }
  }

  private async imageOf(row: DocRow): Promise<ModelImage | null> {
    try {
      return await this.deps.pool.run('modelImage', { path: this.deps.docs.readablePath(row) }, { priority: 'user' });
    } catch (error) {
      this.deps.ctx.logger.warn('agent', 'Attachment image could not be prepared', { documentId: row.id, error });
      return null;
    }
  }
}
