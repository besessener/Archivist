import { sha256Text } from '../util/hash';
import { truncate } from '../util/text';
import { contentWords, overlaps, relatedPairs } from './contradiction-rules';

/** Upper bound of LLM questions per scan about document pairs; every answer is stored, so the next scan continues with the rest. */
export const MAX_DOCUMENT_REVIEWS_PER_SCAN = 30;

/** Per topic or project only the newest documents are compared, so a scan stays bounded. */
const MAX_DOCUMENTS_PER_GROUP = 40;

const SUMMARY_CHARS = 600;
const TEXT_CHARS = 1200;

export interface DocumentSource {
  title: string;
  summary: string | null;
  /** Beginning of the extracted text. */
  text: string;
}

/** What is sent to the LLM of a document, and what a verdict is cached by: title, summary and the beginning of the text. */
export function documentStatement({ title, summary, text }: DocumentSource): string {
  return [title, truncate(summary ?? '', SUMMARY_CHARS), truncate(text, TEXT_CHARS)].filter(Boolean).join('\n');
}

/** Hash of both statements, independent of their order: a verdict stays valid as long as the texts do. */
export const documentPairHash = (a: string, b: string): string => sha256Text(['document', ...[a, b].sort()].join('\n'));

export const documentPairKey = (a: string, b: string): string => `document:${[a, b].sort().join('|')}`;

export interface DocumentCandidate {
  id: string;
  topicId: string | null;
  projectId: string | null;
  statement: string;
}

/** Documents of the same topic or project that speak about the same thing, each pair once, in the order of the candidates (newest first). */
export function documentPairs<T extends DocumentCandidate>(candidates: T[]): Array<[T, T]> {
  const words = new Map(candidates.map((candidate) => [candidate.id, contentWords(candidate.statement)]));
  return relatedPairs(candidates, { maxPerGroup: MAX_DOCUMENTS_PER_GROUP }).filter(([first, second]) => overlaps(words.get(first.id)!, words.get(second.id)!));
}
