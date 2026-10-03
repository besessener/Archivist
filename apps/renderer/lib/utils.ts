import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Date as YYYY-MM-DD (local time). */
export function toIsoDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(days: number, from: Date = new Date()): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** Next Monday (tomorrow at the earliest). */
export function nextMonday(from: Date = new Date()): Date {
  const date = new Date(from);
  const daysAhead = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + daysAhead);
  return date;
}

/** A copy of `set` that contains `value` exactly when `present`. */
export function withMembership<T>(set: Set<T>, { value, present }: { value: T; present: boolean }): Set<T> {
  const next = new Set(set);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}

export function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function nonEmpty(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
