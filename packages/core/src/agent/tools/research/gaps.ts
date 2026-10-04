const monthIndex = (yearMonth: string) => Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(5, 7)) - 1;
const monthKey = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/** Months (YYYY-MM) present between the first and last date, and the missing ones. */
export function monthGaps(days: string[]): { first: string | null; last: string | null; present: string[]; missing: string[] } {
  const months = [...new Set(days.filter((d) => /^\d{4}-\d{2}/.test(d)).map((d) => d.slice(0, 7)))].toSorted();
  if (!months.length) return { first: null, last: null, present: [], missing: [] };
  const have = new Set(months);
  const missing: string[] = [];
  for (let i = monthIndex(months[0]!); i <= monthIndex(months.at(-1)!) && missing.length < 600; i += 1) if (!have.has(monthKey(i))) missing.push(monthKey(i));
  return { first: months[0]!, last: months.at(-1)!, present: months, missing };
}

/** Sequence number in a name: „Nr. 12“, „Auszug 3“, „#7“ (number) or „2025-07“ (month). */
export function sequenceNumber(name: string): { kind: 'number'; n: number } | { kind: 'month'; month: string } | null {
  const labelled = /(?:\bnr|\bno|\bnummer|\bauszug|\bkontoauszug|\bteil|\bheft|\bausgabe|\brechnung|#)\.?\s?[:#]?\s?(\d{1,6})\b(?![-_./]\d)/i.exec(name);
  if (labelled) return { kind: 'number', n: Number(labelled[1]) };
  const month = /(?<!\d)(20\d{2}|19\d{2})[-_.](0[1-9]|1[0-2])(?!\d)/.exec(name);
  if (month) return { kind: 'month', month: `${month[1]}-${month[2]}` };
  const trailing = /(?:^|[\s_-])(\d{1,4})(?:\D*)$/.exec(name);
  return trailing ? { kind: 'number', n: Number(trailing[1]) } : null;
}

/** Missing numbers between the smallest and the largest one (at most 500). */
export function numberGaps(numbers: number[]): number[] {
  const sorted = [...new Set(numbers)].toSorted((a, b) => a - b);
  if (sorted.length < 2) return [];
  const have = new Set(sorted);
  const missing: number[] = [];
  for (let n = sorted[0]!; n <= sorted.at(-1)! && missing.length < 500; n += 1) if (!have.has(n)) missing.push(n);
  return missing;
}
