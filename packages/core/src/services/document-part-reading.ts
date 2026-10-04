import { DocumentClassification } from '@archivist/shared';
import { maskingOf } from '../util/redact';
import { isTokenCapError } from '../util/token-cap';
import { classificationRequest, widestSubjects } from './document-classification';
import type { DocRow, DocumentDeps } from './document-model';
import { MAX_LLM_PARTS, cutKeepsMasking, partSize, splitIntoParts } from './document-parts';

export interface PartsRead {
  results: [DocumentClassification, ...DocumentClassification[]];
  /** What the LLM read of the text: characters and requests. */
  read: { chars: number; parts: number };
}

/** A long text is read in consecutive parts, each its own checked, masked and logged request; a failing later part keeps what was read so far. */
export async function classifyInParts(
  deps: Pick<DocumentDeps, 'ctx' | 'settings' | 'graph' | 'llm' | 'categories'>,
  input: { row: DocRow; text: string; signal?: AbortSignal },
): Promise<PartsRead> {
  const { row, text, signal } = input;
  const confirmed = {
    topics: deps.graph.entityNames({ type: 'topic', confirmedOnly: true }),
    projects: deps.graph.entityNames({ type: 'project', confirmedOnly: true }),
  };
  const context = { mainCategories: deps.categories.mainCategories(), confirmed };
  // measured with the longest names any part could list, so no part's request outgrows the limit and gets cut
  const promptChars = classificationRequest(row, {
    ...context,
    confirmed: widestSubjects(confirmed),
    text: '',
    part: { number: MAX_LLM_PARTS, of: MAX_LLM_PARTS },
  }).input.length;
  const settings = deps.settings.get();
  const masking = maskingOf(settings);
  const parts = splitIntoParts(text, partSize({ maxInputChars: settings.llm.maxInputChars, promptChars }), (whole, position) =>
    cutKeepsMasking(whole, position, masking),
  );
  const complete = (part: string, number: number) =>
    deps.llm.completeJson(DocumentClassification, {
      ...classificationRequest(row, { ...context, text: part, part: parts.length > 1 ? { number, of: parts.length } : undefined }),
      signal,
    });
  const results: PartsRead['results'] = [await complete(parts[0]!, 1)];
  let chars = parts[0]!.length;
  for (const [index, part] of parts.slice(1).entries()) {
    signal?.throwIfAborted();
    try {
      results.push(await complete(part, index + 2));
      chars += part.length;
    } catch (err) {
      signal?.throwIfAborted();
      if (isTokenCapError(err)) throw err;
      deps.ctx.logger.warn('documents', 'LLM analysis of a later part failed', { documentId: row.id, part: index + 2, error: err });
      break;
    }
  }
  return { results, read: { chars, parts: results.length } };
}
