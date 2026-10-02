const MONTH_NAMES: Record<string, number> = {
  januar: 1,
  jan: 1,
  februar: 2,
  feb: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  apr: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  dezember: 12,
  dez: 12,
};

export const twoDigits = (value: number) => String(value).padStart(2, '0');
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
/** A two-digit year means 20xx. */
export const fullYear = (digits: string) => (digits.length === 2 ? 2000 + Number(digits) : Number(digits));

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** YYYY-MM-DD of a calendar date, or null when it does not exist. */
export function isoOf({ year, month, day }: CalendarDay): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
}

/** 2026-12-31 → „31.12.2026“ (deterministic). */
export const formatGermanDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export type PeriodUnit = 'tag' | 'woche' | 'monat' | 'jahr';

export interface Period {
  /** Negative counts back. */
  count: number;
  unit: PeriodUnit;
}

/** Adds a period; months are clamped, and a month end stays a month end when counting back. */
export function addPeriod(iso: string, { count, unit }: Period): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (unit === 'tag' || unit === 'woche') {
    const date = new Date(Date.UTC(year, month - 1, day + count * (unit === 'woche' ? 7 : 1)));
    return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
  }
  const index = year * 12 + (month - 1) + count * (unit === 'jahr' ? 12 : 1);
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const monthEnd = day === daysInMonth(year, month);
  const targetDay = count < 0 && monthEnd ? daysInMonth(targetYear, targetMonth) : Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${twoDigits(targetMonth)}-${twoDigits(targetDay)}`;
}

export interface DateHit {
  iso: string;
  index: number;
  end: number;
  monthOnly: boolean;
}

const DATE_PATTERNS: Array<{ re: RegExp; parse: (m: RegExpExecArray) => { iso: string | null; monthOnly: boolean } }> = [
  {
    re: /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)/g,
    parse: (m) => ({ iso: isoOf({ year: fullYear(m[3]!), month: Number(m[2]), day: Number(m[1]) }), monthOnly: false }),
  },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => ({ iso: isoOf({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }), monthOnly: false }) },
  {
    re: /\b(\d{1,2})\.\s?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s(\d{4})\b/gi,
    parse: (m) => ({ iso: isoOf({ year: Number(m[3]), month: MONTH_NAMES[m[2]!.toLowerCase()] ?? 0, day: Number(m[1]) }), monthOnly: false }),
  },
  {
    // month/year („HU 08/2027“, „gültig bis 03/2030“) → last day of the month
    re: /(?<![\d./])(0?[1-9]|1[0-2])\/(\d{4}|\d{2})(?![\d/])/g,
    parse: (m) => {
      const year = fullYear(m[2]!);
      const month = Number(m[1]);
      return { iso: isoOf({ year, month, day: daysInMonth(year, month) }), monthOnly: true };
    },
  },
];

/** All dates in a text with their position. */
export function findDates(text: string): DateHit[] {
  const hits: DateHit[] = [];
  for (const { re, parse } of DATE_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const { iso, monthOnly } = parse(m);
      const start = m.index;
      const end = start + m[0].length;
      if (iso && !hits.some((h) => start < h.end && h.index < end)) hits.push({ iso, index: start, end, monthOnly });
    }
  }
  return hits.toSorted((a, b) => a.index - b.index);
}
