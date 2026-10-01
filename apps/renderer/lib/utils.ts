import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Datum als YYYY-MM-DD (lokale Zeit). */
export function toIsoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(days: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

/** Nächster Montag (mindestens morgen). */
export function nextMonday(from: Date = new Date()): Date {
  const d = new Date(from);
  const diff = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

export function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function nonEmpty(text: string): string | undefined {
  const t = text.trim();
  return t.length > 0 ? t : undefined;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
