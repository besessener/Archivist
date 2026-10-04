import type { DocumentRecord } from '@archivist/shared';

/** A document of an export with its readable file (null: missing) and recognized amount. */
export interface ExportItem {
  doc: DocumentRecord;
  file: string | null;
  amount: number | null;
  folder: string;
}

export const formatAmount = (amount: number) => `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
export const csvNumber = (amount: number) => amount.toFixed(2).replace('.', ',');

/** Months (YYYY-MM) between the first and the last date without any document. */
export function monthGaps(days: string[]): string[] {
  const months = new Set(days.filter((d) => /^\d{4}-\d{2}/.test(d)).map((d) => d.slice(0, 7)));
  if (months.size < 2) return [];
  const sorted = [...months].toSorted();
  const gaps: string[] = [];
  const index = (yearMonth: string) => Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(5, 7)) - 1;
  const last = index(sorted.at(-1)!);
  for (let i = index(sorted[0]!) + 1; i < last; i += 1) {
    const key = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    if (!months.has(key)) gaps.push(key);
  }
  return gaps;
}

export const sumOf = (items: ExportItem[]) => Math.round(items.reduce((sum, i) => sum + (i.amount ?? 0) * 100, 0)) / 100;
export const withAmount = (items: ExportItem[]) => items.filter((i) => i.amount !== null).length;
