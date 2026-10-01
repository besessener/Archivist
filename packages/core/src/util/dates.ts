/** Lokale deutsche Datumserkennung (relativ und absolut) – funktioniert ohne LLM. */

const MONTHS: Record<string, number> = {
  januar: 1,
  jan: 1,
  februar: 2,
  feb: 2,
  märz: 3,
  maerz: 3,
  mär: 3,
  april: 4,
  apr: 4,
  mai: 5,
  juni: 6,
  jun: 6,
  juli: 7,
  jul: 7,
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
const WEEKDAYS: Record<string, number> = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6 };
const NUMBER_WORDS: Record<string, number> = {
  ein: 1,
  eine: 1,
  einem: 1,
  einen: 1,
  einer: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwölf: 12,
  zwoelf: 12,
  vierzehn: 14,
};

const pad = (n: number) => String(n).padStart(2, '0');

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return toIsoDate(dt);
}

/** Wandelt zweistellige Jahre um (26 → 2026). */
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

function nextWeekday(from: Date, weekday: number, strictlyAfter = true): Date {
  const diff = (weekday - from.getDay() + 7) % 7;
  const add = diff === 0 && strictlyAfter ? 7 : diff;
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + add);
}

/**
 * Erkennt das erste Datum in einem deutschen Text und liefert ISO (YYYY-MM-DD) oder null.
 * Unterstützt: ISO, 12.06.2026, 12.6.26, 12. Juni (2026), heute/morgen/übermorgen/gestern,
 * "in sieben Tagen/Wochen/Monaten", "nächsten Montag", "nächste Woche", "nächsten Monat".
 */
export function parseGermanDate(input: string, now: Date = new Date()): string | null {
  const text = input.toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/.exec(text);
  if (m) return validDate(fullYear(Number(m[3])), Number(m[2]), Number(m[1]));

  m = /\b(\d{1,2})\.\s?([a-zäöü]+)\.?(?:\s+(\d{4}))?/.exec(text);
  if (m && m[2] && MONTHS[m[2]] !== undefined) {
    return validDate(m[3] ? Number(m[3]) : today.getFullYear(), MONTHS[m[2]]!, Number(m[1]));
  }

  m = /\b(\d{1,2})\.\s?(\d{1,2})\.(?!\d)/.exec(text);
  if (m) return validDate(today.getFullYear(), Number(m[2]), Number(m[1]));

  if (/\bübermorgen\b|\buebermorgen\b/.test(text)) return toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2));
  if (/\bmorgen\b/.test(text)) return toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  if (/\bgestern\b/.test(text)) return toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  if (/\bheute\b/.test(text)) return toIsoDate(today);

  m = /\bin\s+(\d+|[a-zäöü]+)\s+(tag|tagen|woche|wochen|monat|monaten)\b/.exec(text);
  if (m) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!];
    if (n !== undefined) {
      const unit = m[2]!;
      if (unit.startsWith('tag')) return toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
      if (unit.startsWith('woche')) return toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7 * n));
      return toIsoDate(new Date(today.getFullYear(), today.getMonth() + n, today.getDate()));
    }
  }

  m = /\b(?:nächste[nrms]?|naechste[nrms]?|kommende[nrms]?|am)\s+(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)\b/.exec(text);
  if (m) return toIsoDate(nextWeekday(today, WEEKDAYS[m[1]!]!));
  m = /\b(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)\b/.exec(text);
  if (m) return toIsoDate(nextWeekday(today, WEEKDAYS[m[1]!]!));

  if (/\bnächste[nrm]?\s+woche\b|\bnaechste[nrm]?\s+woche\b/.test(text)) return toIsoDate(nextWeekday(today, 1));
  if (/\bnächste[nrm]?\s+monat\b|\bnaechste[nrm]?\s+monat\b/.test(text)) return toIsoDate(new Date(today.getFullYear(), today.getMonth() + 1, today.getDate()));

  m = /\b(?:im\s+)?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+(\d{4})\b/.exec(text);
  if (m) return validDate(Number(m[2]), MONTHS[m[1]!]!, 1);

  return null;
}

/** Normalisiert ein vom LLM geliefertes Datum (ISO oder deutsch) zu ISO oder null. */
export function normalizeDateInput(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) {
    const iso = validDate(Number(v.slice(0, 4)), Number(v.slice(5, 7)), Number(v.slice(8, 10)));
    return iso ? (v.length > 10 ? v : iso) : null;
  }
  return parseGermanDate(v, now);
}
