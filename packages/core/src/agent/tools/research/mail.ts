import type { DocumentRecord } from '@archivist/shared';

/** Subject without Re:/AW:/WG:/Fwd:/FW: prefixes, lower case. */
export function normalizeSubject(subject: string): string {
  let normalized = subject.trim();
  for (let i = 0; i < 10; i += 1) {
    const next = normalized.replace(/^(?:re|aw|wg|fwd?|fw|antw|sv|vs)(?:\[\d+\])?\s?:\s*/i, '').trim();
    if (next === normalized) break;
    normalized = next;
  }
  return normalized.replace(/\s+/g, ' ').toLowerCase();
}

/** Mails grouped by normalized subject (from the text preview, else the title): threads of two or more, largest first. */
export function mailThreads(mails: DocumentRecord[]): Array<[string, DocumentRecord[]]> {
  const groups = new Map<string, DocumentRecord[]>();
  for (const d of mails) {
    const subject = /^Betreff:\s?(.*?)\s(?:Von|An|Datum):/.exec(d.textPreview)?.[1] ?? d.title;
    const key = normalizeSubject(subject);
    if (key) groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups].filter(([, group]) => group.length >= 2).toSorted((x, y) => y[1].length - x[1].length);
}
