import path from 'node:path';
import type { DocumentRecord } from '@archivist/shared';

/** Values for a naming scheme like `{datum} {typ} {absender}` (#304). */
export function fillPattern(
  pattern: string,
  d: Pick<DocumentRecord, 'documentDate' | 'archivedAt' | 'createdAt' | 'docType' | 'persons' | 'title' | 'topicName' | 'projectName' | 'originalName'>,
): string {
  const date = (d.documentDate ?? d.archivedAt ?? d.createdAt).slice(0, 10);
  const values: Record<string, string> = {
    datum: date,
    date,
    jahr: date.slice(0, 4),
    monat: date.slice(0, 7),
    typ: d.docType ?? '',
    absender: d.persons[0] ?? '',
    titel: d.title,
    thema: d.topicName ?? '',
    projekt: d.projectName ?? '',
    original: path.basename(d.originalName, path.extname(d.originalName)),
  };
  const filled = pattern.replace(/\{(\w+)\}/g, (_, k: string) => values[k.toLowerCase()] ?? '').replace(/\s{2,}/g, ' ');
  // separators left over at the ends when a placeholder was empty
  let start = 0;
  let end = filled.length;
  while (start < end && ' _-'.includes(filled[start]!)) start += 1;
  while (end > start && ' _-'.includes(filled[end - 1]!)) end -= 1;
  return filled.slice(start, end).trim();
}
