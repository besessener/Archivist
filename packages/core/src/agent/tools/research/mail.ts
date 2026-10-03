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

/** Threading headers of a mail as the .eml parser stores them (all null/empty for mails read before they were stored). */
export interface MailHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

export interface MailEntry {
  doc: DocumentRecord;
  headers: MailHeaders;
}

export interface MailThread {
  /** Normalized subject of the first mail. */
  label: string;
  mails: DocumentRecord[];
  /** headers: Message-ID/In-Reply-To/References; subject: mails without such headers, grouped by subject only. */
  basis: 'headers' | 'subject';
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const messageKey = (id: string) => id.replace(/^<|>$/g, '').trim().toLowerCase();

/** Threading headers from the stored technical metadata of a document. */
export function mailHeadersOf(meta: unknown): MailHeaders {
  const fields = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  const references = text(fields.references)?.split(/\s+/).filter(Boolean) ?? [];
  return { messageId: text(fields.messageId), inReplyTo: text(fields.inReplyTo), references };
}

const idsOf = (headers: MailHeaders): string[] =>
  [headers.messageId, headers.inReplyTo, ...headers.references].filter((id): id is string => Boolean(id)).map(messageKey);

/** Disjoint sets of message ids: ids named together in one mail belong to the same thread. */
function threadIdSets(entries: MailEntry[]): (id: string) => string {
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    const up = parent.get(id) ?? id;
    return up === id ? id : root(up);
  };
  for (const { headers } of entries) {
    const [first, ...rest] = idsOf(headers);
    if (!first) continue;
    for (const id of rest) parent.set(root(id), root(first));
  }
  return root;
}

const subjectOf = (d: DocumentRecord) => normalizeSubject(/^Betreff:\s?(.*?)\s(?:Von|An|Datum):/.exec(d.textPreview)?.[1] ?? d.title);

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

const firstOf = (group: DocumentRecord[]) => group.toSorted((x, y) => (x.documentDate ?? x.createdAt).localeCompare(y.documentDate ?? y.createdAt))[0]!;

/**
 * Threads of two or more mails, largest first. Mails with Message-ID/In-Reply-To/References headers are joined by those ids, so equal subjects of
 * different threads stay apart; mails without any such header are grouped by normalized subject (deterministic, but a guess).
 */
export function mailThreads(entries: MailEntry[]): MailThread[] {
  const root = threadIdSets(entries);
  const threaded = entries.filter((e) => idsOf(e.headers).length);
  const byHeaders = groupBy(threaded, (e) => root(idsOf(e.headers)[0]!));
  const bySubject = groupBy(
    entries.filter((e) => !idsOf(e.headers).length),
    (e) => subjectOf(e.doc),
  );
  const threads: Array<Omit<MailThread, 'label'>> = [
    ...[...byHeaders.values()].map((group) => ({ mails: group.map((e) => e.doc), basis: 'headers' as const })),
    ...[...bySubject].filter(([subject]) => subject).map(([, group]) => ({ mails: group.map((e) => e.doc), basis: 'subject' as const })),
  ].filter((thread) => thread.mails.length >= 2);
  return threads
    .map((thread) => ({ ...thread, label: subjectOf(firstOf(thread.mails)) }))
    .toSorted((x, y) => y.mails.length - x.mails.length || x.label.localeCompare(y.label));
}
