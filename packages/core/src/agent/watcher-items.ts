import { localDate, type Reminder } from '@archivist/shared';
import { ARCHIVED, type ToolDeps } from './tools/common';
import { coverageLookup, scanDeadlines } from './tools/research/deadline-coverage';
import { DEADLINE_LABEL } from './tools/research/deadlines';

export const OPEN_ITEMS_HREF = '/open-items/';
export const documentHref = (id: string) => `/documents/?id=${encodeURIComponent(id)}`;
export const decisionHref = (id: string) => `/decisions/?id=${encodeURIComponent(id)}`;

/** Something due: an open item, a reminder or a deadline in a document that nothing else stands for yet. */
export interface DeadlineItem {
  key: string;
  day: string;
  title: string;
  text: string;
  urgent: boolean;
  /** In-app page of the concerned entry. */
  href: string;
}

export interface DeadlineWindow {
  today: string;
  /** Items due up to here are collected. */
  horizon: string;
  /** Items due up to here are urgent. */
  soon: string;
  now: Date;
}

type ItemDeps = Pick<ToolDeps, 'openItems' | 'reminders' | 'docs' | 'privacy'>;

const reminderHref = (reminder: Reminder): string => {
  if (reminder.targetType === 'document' && reminder.targetId) return documentHref(reminder.targetId);
  if (reminder.targetType === 'decision' && reminder.targetId) return decisionHref(reminder.targetId);
  return OPEN_ITEMS_HREF;
};

const dueText = (day: string, today: string, what: { upcoming: string; title: string }) =>
  day < today ? `überfällig seit ${day}: ${what.title}` : `${what.upcoming} ${day}: ${what.title}`;

function openItemItems(deps: ItemDeps, window: DeadlineWindow): DeadlineItem[] {
  return deps.openItems.list({ onlyActive: true }).flatMap((item) => {
    const day = item.dueAt ? localDate(item.dueAt) : null;
    if (!day || day > window.horizon) return [];
    return [
      {
        key: `oi:${item.id}`,
        day,
        title: item.title,
        urgent: day <= window.soon,
        href: OPEN_ITEMS_HREF,
        text: dueText(day, window.today, { upcoming: 'fällig am', title: item.title }),
      },
    ];
  });
}

function reminderItems(deps: ItemDeps, window: DeadlineWindow): DeadlineItem[] {
  return deps.reminders.list('pending').flatMap((reminder) => {
    const day = localDate(reminder.remindAt);
    if (day > window.horizon) return [];
    return [
      {
        key: `rem:${reminder.id}`,
        day,
        title: reminder.title,
        urgent: day <= window.soon,
        href: reminderHref(reminder),
        text: dueText(day, window.today, { upcoming: 'Frist/Erinnerung am', title: reminder.title }),
      },
    ];
  });
}

/** Upcoming deadlines in released archived documents that have neither a reminder nor an open item. Past ones are not reported. */
function documentDeadlineItems(deps: ItemDeps, window: DeadlineWindow): DeadlineItem[] {
  const documents = deps.docs.list({ statuses: ARCHIVED, limit: 5000 }).filter((d) => deps.privacy.mayShareDocument(d));
  const covered = coverageLookup(deps);
  return scanDeadlines(deps, { documents, today: window.now }).flatMap(({ document, deadline }) => {
    const { date } = deadline;
    if (!date || date < window.today || date > window.horizon || covered(document.id, { kind: deadline.kind, date })) return [];
    const title = `${DEADLINE_LABEL[deadline.kind]}: ${document.title}`;
    return [
      {
        key: `dl:${document.id}:${deadline.kind}:${date}`,
        day: date,
        title,
        urgent: date <= window.soon,
        href: documentHref(document.id),
        text: `Frist am ${date}: ${title}`,
      },
    ];
  });
}

/** Everything due up to the horizon: open items and pending reminders (overdue ones included) and uncovered document deadlines. */
export function collectDeadlineItems(deps: ItemDeps, window: DeadlineWindow): DeadlineItem[] {
  return [...openItemItems(deps, window), ...reminderItems(deps, window), ...documentDeadlineItems(deps, window)];
}
