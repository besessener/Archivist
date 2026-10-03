import { addPeriod, formatGermanDate, type Period } from './dates';

const SERIAL_LABEL_RE =
  /(?<![\p{L}\d])(?:seriennummer|seriennr\.?|serial(?:\s?(?:number|no\.?|nr\.?))?|s\/n|sn(?=\s*:))(?:\s*[:#]\s*|\s+)([A-Z0-9][A-Z0-9-]{4,29})(?![A-Z0-9-])/giu;

/** A serial number as stored: 5–30 characters (letters, digits, hyphen), upper case, at least one digit and not one repeated character; else null. */
export function validateSerialNumber(raw: string): string | null {
  const serial = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{4,29}$/.test(serial) || !/\d/.test(serial)) return null;
  return new Set(serial.replaceAll('-', '')).size > 1 ? serial : null;
}

/** The first valid serial number named by a label („Seriennummer: SN-4711-AB“, „S/N 123456789“, „Serial No: C02XK1“). */
export function extractSerialNumber(text: string): { serial: string; line: string } | null {
  for (const match of text.matchAll(SERIAL_LABEL_RE)) {
    const serial = validateSerialNumber(match[1]!);
    if (serial) return { serial, line: match[0].trim() };
  }
  return null;
}

const COUNT_WORDS: Record<string, number> = { ein: 1, eine: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5 };
const WARRANTY_BEFORE_RE = /(\d{1,2}|ein|eine|einem|zwei|drei|vier|fünf)\s(monate?n?|jahre?n?)\s(?:herstellergarantie|garantie|gewährleistung)/i;
const WARRANTY_AFTER_RE =
  /(?:herstellergarantie|garantie|gewährleistung)(?::|\s(?:von|beträgt|betraegt))?\s{1,3}(\d{1,2}|ein|eine|einem|zwei|drei|vier|fünf)\s(monate?n?|jahre?n?)/i;

/** Warranty period named in a receipt text („24 Monate Garantie“, „Garantie: 2 Jahre“); null when none is named. */
export function warrantyPeriodIn(text: string): { period: Period; line: string } | null {
  const match = WARRANTY_BEFORE_RE.exec(text) ?? WARRANTY_AFTER_RE.exec(text);
  if (!match) return null;
  const count = /^\d+$/.test(match[1]!) ? Number(match[1]) : COUNT_WORDS[match[1]!.toLowerCase()]!;
  return { period: { count, unit: /^jahr/i.test(match[2]!) ? 'jahr' : 'monat' }, line: match[0] };
}

/** The legal warranty in Germany: two years from the purchase – used when the receipt names no period. */
export const LEGAL_WARRANTY: Period = { count: 24, unit: 'monat' };

export interface Warranty {
  /** YYYY-MM-DD */
  end: string;
  /** „Kaufdatum 15.03.2026 + 2 Jahre = 15.03.2028“ */
  rechenweg: string;
}

const periodText = ({ count, unit }: Period) => `${count} ${unit === 'jahr' ? (count === 1 ? 'Jahr' : 'Jahre') : count === 1 ? 'Monat' : 'Monate'}`;

/** Warranty end = purchase date + period, with the computation path. */
export function warrantyFrom(purchaseDate: string, period: Period): Warranty {
  const end = addPeriod(purchaseDate, period);
  return { end, rechenweg: `Kaufdatum ${formatGermanDate(purchaseDate)} + ${periodText(period)} = ${formatGermanDate(end)}` };
}
