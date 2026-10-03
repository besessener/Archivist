import { localDate, type DocumentRecord, type OpenItem, type Reminder } from '@archivist/shared';
import type { ToolDeps } from '../common';
import { addPeriod, formatGermanDate } from './dates';
import { DEADLINE_LABEL, findDeadlines, type Deadline, type DeadlineKind } from './deadlines';

export interface DatedDeadline {
  kind: DeadlineKind;
  date: string;
}

export interface DocumentDeadline {
  document: DocumentRecord;
  deadline: Deadline;
}

export type DeadlineCoverage = { by: 'reminder'; reminder: Reminder } | { by: 'open_item'; openItem: OpenItem };

/** Start of the title of a reminder created for a deadline – the key that tells later calls the deadline is covered. */
export const deadlineTitlePrefix = (deadline: DatedDeadline) => `${DEADLINE_LABEL[deadline.kind]} ${formatGermanDate(deadline.date)}`;

/** Day a reminder for the deadline is due: the lead time before it, but never in the past. */
export function reminderDay({ deadline, leadDays, today }: { deadline: DatedDeadline; leadDays: number; today: string }): string {
  const lead = addPeriod(deadline.date, { count: -leadDays, unit: 'tag' });
  return lead < today ? today : lead;
}

/** Deadlines of the documents' texts, each with its document. */
export function scanDeadlines(deps: Pick<ToolDeps, 'docs'>, { documents, today }: { documents: readonly DocumentRecord[]; today: Date }): DocumentDeadline[] {
  return documents.flatMap((document) => {
    const baseDate = document.documentDate ? document.documentDate.slice(0, 10) : (document.archivedAt ?? document.createdAt).slice(0, 10);
    const text = deps.docs.findRow(document.id)?.extractedText ?? '';
    return findDeadlines(text, { baseDate, today, baseLabel: document.documentDate ? 'Dokumentdatum' : 'Archivdatum' }).map((deadline) => ({
      document,
      deadline,
    }));
  });
}

/** Looks up whether a pending reminder or an active open item of the document already stands for a deadline. */
export function coverageLookup(deps: Pick<ToolDeps, 'reminders' | 'openItems'>): (documentId: string, deadline: DatedDeadline) => DeadlineCoverage | null {
  const reminders = deps.reminders.list('pending');
  const openItems = deps.openItems.list({ onlyActive: true });
  return (documentId, deadline) => {
    const prefix = deadlineTitlePrefix(deadline);
    const reminder = reminders.find((r) => r.targetId === documentId && (r.title.startsWith(prefix) || localDate(r.remindAt) === deadline.date));
    if (reminder) return { by: 'reminder', reminder };
    const openItem = openItems.find((o) => o.sourceIds.includes(documentId) && o.dueAt && localDate(o.dueAt) === deadline.date);
    return openItem ? { by: 'open_item', openItem } : null;
  };
}
