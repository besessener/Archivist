import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatAttachContentInput, ChatAttachOutcome } from '@archivist/shared';
import { sanitizeFileName } from '../../util/paths';
import type { DocumentService } from '../documents';
import type { ImportOptions } from '../document-model';

const FOLDER_REFUSED = 'Ordner kannst du nicht anhängen – nutze dafür „Ordner importieren“.';

/** One picked file for a chat message: imported like any upload (inbox copy, audit, analysis) but without notifications. */
export async function importAttachment(docs: DocumentService, file: string, options: Pick<ImportOptions, 'temporarySource'> = {}): Promise<ChatAttachOutcome> {
  // a folder would start a background import job; the chat only takes files
  const stat = await fsp.stat(file).catch(() => null);
  if (stat?.isDirectory()) return { kind: 'rejected', path: file, reason: FOLDER_REFUSED };
  const result = await docs.importPaths([file], { ...options, notify: false });
  const document = result.imported[0] ?? (result.duplicates[0] ? docs.get(result.duplicates[0].existingDocumentId) : null);
  if (document) return { kind: 'attached', path: file, attachment: { documentId: document.id, name: document.originalName, ext: document.ext } };
  return { kind: 'rejected', path: file, reason: result.rejected[0]?.reason ?? 'Die Datei konnte nicht übernommen werden.' };
}

/** A file known only by its content (a pasted image): imported from a temporary copy that is removed again. */
export async function importAttachmentContent(docs: DocumentService, file: ChatAttachContentInput): Promise<ChatAttachOutcome> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archivist-attachment-'));
  try {
    const copy = path.join(dir, sanitizeFileName(file.name));
    await fsp.writeFile(copy, file.content, { flag: 'wx' });
    return { ...(await importAttachment(docs, copy, { temporarySource: true })), path: file.name };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
