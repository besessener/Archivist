import path from 'node:path';
import type { DocumentRecord } from '@archivist/shared';

/** Values for a naming scheme like `{datum} {typ} {absender}` (#304). */
export function fillPattern(
  pattern: string,
  doc: Pick<DocumentRecord, 'documentDate' | 'archivedAt' | 'createdAt' | 'docType' | 'persons' | 'title' | 'topicName' | 'projectName' | 'originalName'>,
): string {
  const date = (doc.documentDate ?? doc.archivedAt ?? doc.createdAt).slice(0, 10);
  const values: Record<string, string> = {
    datum: date,
    date,
    jahr: date.slice(0, 4),
    monat: date.slice(0, 7),
    typ: doc.docType ?? '',
    absender: doc.persons[0] ?? '',
    titel: doc.title,
    thema: doc.topicName ?? '',
    projekt: doc.projectName ?? '',
    original: path.basename(doc.originalName, path.extname(doc.originalName)),
  };
  const filled = pattern.replace(/\{(\w+)\}/g, (_, key: string) => values[key.toLowerCase()] ?? '').replace(/\s{2,}/g, ' ');
  // separators left over at the ends when a placeholder was empty
  let start = 0;
  let end = filled.length;
  while (start < end && ' _-'.includes(filled[start]!)) start += 1;
  while (end > start && ' _-'.includes(filled[end - 1]!)) end -= 1;
  return filled.slice(start, end).trim();
}
