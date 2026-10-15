import fsp from 'node:fs/promises';
import type { ChatAttachResult } from '@archivist/shared';
import type { DocumentService } from '../documents';

type AttachOutcome = ChatAttachResult[number];

const FOLDER_REFUSED = 'Ordner kannst du nicht anhängen – nutze dafür „Ordner importieren“.';

/** One picked file for a chat message: imported like any upload (inbox copy, audit, analysis) but without notifications. */
export async function importAttachment(docs: DocumentService, path: string): Promise<AttachOutcome> {
  // a folder would start a background import job; the chat only takes files
  const stat = await fsp.stat(path).catch(() => null);
  if (stat?.isDirectory()) return { kind: 'rejected', path, reason: FOLDER_REFUSED };
  const result = await docs.importPaths([path], { notify: false });
  const document = result.imported[0] ?? (result.duplicates[0] ? docs.get(result.duplicates[0].existingDocumentId) : null);
  if (document) return { kind: 'attached', path, attachment: { documentId: document.id, name: document.originalName, ext: document.ext } };
  return { kind: 'rejected', path, reason: result.rejected[0]?.reason ?? 'Die Datei konnte nicht übernommen werden.' };
}
