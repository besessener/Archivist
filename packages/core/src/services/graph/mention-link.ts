import type { LinkOptions } from './relations';

/** A person named in a document's text: a fact of the text, so confirmed, but never decided by the user (#189). */
export function mentionLink(documentId: string): LinkOptions {
  return { confidence: 0.6, status: 'confirmed', method: 'mention', sourceIds: [documentId] };
}
