import { localDate, localToday } from '@archivist/shared';
import type { OpenItemRecord } from './types';
import { toIsoDay } from './utils';

export type OpenItemGroup = 'overdue' | 'due' | 'open' | 'done';

/** Local days bounding „Überfällig“ (before `today`) and „Bald fällig“ (up to `dueSoonUntil`). */
export interface DueWindow {
  today: string;
  dueSoonUntil: string;
}

export function dueWindow(dueSoonDays: number, now: Date = new Date()): DueWindow {
  const until = new Date(now);
  until.setDate(until.getDate() + dueSoonDays);
  return { today: localToday(now), dueSoonUntil: toIsoDay(until) };
}

export function groupOf(item: OpenItemRecord, window: DueWindow): OpenItemGroup {
  if (item.status === 'resolved' || item.status === 'dismissed') return 'done';
  if (!item.dueAt) return 'open';
  const due = localDate(item.dueAt);
  if (due < window.today) return 'overdue';
  return due <= window.dueSoonUntil ? 'due' : 'open';
}
