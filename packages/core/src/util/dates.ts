/** Local German date recognition (relative and absolute) – works without an LLM. */

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
const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAY = '(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)';
const LAST_WEEKDAY_RE = new RegExp(`\\b(?:letzte[nrms]?|vergangene[nrms]?|vorige[nrms]?)\\s+${WEEKDAY}\\b`);
const NEXT_WEEKDAY_RE = new RegExp(`\\b(?:nächste[nrms]?|naechste[nrms]?|kommende[nrms]?)\\s+${WEEKDAY}\\b`);
const AM_WEEKDAY_RE = new RegExp(`\\bam\\s+${WEEKDAY}\\b`);
const BARE_WEEKDAY_RE = new RegExp(`\\b${WEEKDAY}\\b`);
/** Past tense forms of sein/werden/haben – a bare weekday then means the last one. */
const PAST_AUX_RE = /\b(?:war|waren|warst|wurde|wurden|hatte|hatten|hattest|gewesen)\b/;
/** Past participle (eingereicht, gemacht, abgesprochen); lower case only, so nouns like „Angebot“ do not count. */
const PAST_PARTICIPLE_RE = /\b(?:ab|an|auf|aus|bei|ein|fest|mit|nach|vor|weg|zu|zurück)?ge(?!plant\b)[a-zäöüß]{2,}(?:t|en)\b/;
/** „für/auf/bis Freitag“ names a target and stays the next weekday even in a past context. */
const TARGET_WEEKDAY_RE = new RegExp(`\\b(?:für|auf|bis)\\s+(?:den\\s+)?${WEEKDAY}\\b`);
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

const pad = (value: number) => String(value).padStart(2, '0');

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return toIsoDate(date);
}

/** Converts two-digit years (26 → 2026). */
const fullYear = (year: number) => (year < 100 ? 2000 + year : year);

/** Next weekday strictly after `from`. */
function nextWeekday(from: Date, weekday: number): Date {
  const ahead = (weekday - from.getDay() + 7) % 7;
  const days = ahead === 0 ? 7 : ahead;
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}

/** Last weekday strictly before `from` (on a Friday, „letzten Freitag“ yields the one a week ago). */
function previousWeekday(from: Date, weekday: number): Date {
  const back = (from.getDay() - weekday + 7) % 7 || 7;
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() - back);
}

/** Local date, weekday, time and zone for LLM prompts, e.g. „2026-10-01 (Donnerstag), 00:30 Uhr, Zeitzone Europe/Berlin (UTC+02:00)“. */
export function promptNow(now: Date = new Date(), timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  // via Intl instead of the local getters: independent of the time zone the process currently has
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const offset = get('timeZoneName').replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC');
  return `${get('year')}-${get('month')}-${get('day')} (${WEEKDAY_NAMES[weekday]}), ${get('hour')}:${get('minute')} Uhr, Zeitzone ${timeZone} (${offset})`;
}

interface DateContext {
  /** The input in lower case. */
  text: string;
  input: string;
  today: Date;
}
/** A recognised date expression; `date` is null when it names no valid calendar day („31.02.“). */
type DateMatch = { date: string | null };
type DateMatcher = (context: DateContext) => DateMatch | undefined;

const daysFrom = (today: Date, days: number) => toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));

function isoDate({ text }: DateContext): DateMatch | undefined {
  const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  return match ? { date: validDate(Number(match[1]), Number(match[2]), Number(match[3])) } : undefined;
}

function numericDateWithYear({ text }: DateContext): DateMatch | undefined {
  const match = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/.exec(text);
  return match ? { date: validDate(fullYear(Number(match[3])), Number(match[2]), Number(match[1])) } : undefined;
}

function dayWithMonthName({ text, today }: DateContext): DateMatch | undefined {
  const match = /\b(\d{1,2})\.\s?([a-zäöü]+)\.?(?:\s+(\d{4}))?/.exec(text);
  if (!match || !match[2] || MONTHS[match[2]] === undefined) return undefined;
  return { date: validDate(match[3] ? Number(match[3]) : today.getFullYear(), MONTHS[match[2]]!, Number(match[1])) };
}

function numericDateWithoutYear({ text, today }: DateContext): DateMatch | undefined {
  const match = /\b(\d{1,2})\.\s?(\d{1,2})\.(?!\d)/.exec(text);
  return match ? { date: validDate(today.getFullYear(), Number(match[2]), Number(match[1])) } : undefined;
}

function namedDay({ text, today }: DateContext): DateMatch | undefined {
  if (/\bübermorgen\b|\buebermorgen\b/.test(text)) return { date: daysFrom(today, 2) };
  if (/\bmorgen\b/.test(text)) return { date: daysFrom(today, 1) };
  if (/\bgestern\b/.test(text)) return { date: daysFrom(today, -1) };
  if (/\bheute\b/.test(text)) return { date: toIsoDate(today) };
  return undefined;
}

/** „in sieben Tagen“, „in 2 Wochen“, „in einem Monat“. */
function countedOffset({ text, today }: DateContext): DateMatch | undefined {
  const match = /\bin\s+(\d+|[a-zäöü]+)\s+(tag|tagen|woche|wochen|monat|monaten)\b/.exec(text);
  if (!match) return undefined;
  const count = /^\d+$/.test(match[1]!) ? Number(match[1]) : NUMBER_WORDS[match[1]!];
  if (count === undefined) return undefined;
  const unit = match[2]!;
  if (unit.startsWith('tag')) return { date: daysFrom(today, count) };
  if (unit.startsWith('woche')) return { date: daysFrom(today, 7 * count) };
  return { date: toIsoDate(new Date(today.getFullYear(), today.getMonth() + count, today.getDate())) };
}

/** A bare weekday is the next one, in a past context („war am Montag“, „Freitag eingereicht“) the last one. */
function weekdayDate({ text, input, today }: DateContext): DateMatch | undefined {
  const last = LAST_WEEKDAY_RE.exec(text);
  if (last) return { date: toIsoDate(previousWeekday(today, WEEKDAYS[last[1]!]!)) };
  const next = NEXT_WEEKDAY_RE.exec(text);
  if (next) return { date: toIsoDate(nextWeekday(today, WEEKDAYS[next[1]!]!)) };
  const bare = AM_WEEKDAY_RE.exec(text) ?? BARE_WEEKDAY_RE.exec(text);
  if (!bare) return undefined;
  const past = (PAST_AUX_RE.test(text) || PAST_PARTICIPLE_RE.test(input)) && !TARGET_WEEKDAY_RE.test(text);
  return { date: toIsoDate(past ? previousWeekday(today, WEEKDAYS[bare[1]!]!) : nextWeekday(today, WEEKDAYS[bare[1]!]!)) };
}

function nextWeekOrMonth({ text, today }: DateContext): DateMatch | undefined {
  if (/\bnächste[nrm]?\s+woche\b|\bnaechste[nrm]?\s+woche\b/.test(text)) return { date: toIsoDate(nextWeekday(today, 1)) };
  if (/\bnächste[nrm]?\s+monat\b|\bnaechste[nrm]?\s+monat\b/.test(text))
    return { date: toIsoDate(new Date(today.getFullYear(), today.getMonth() + 1, today.getDate())) };
  return undefined;
}

function monthWithYear({ text }: DateContext): DateMatch | undefined {
  const match = /\b(?:im\s+)?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+(\d{4})\b/.exec(text);
  return match ? { date: validDate(Number(match[2]), MONTHS[match[1]!]!, 1) } : undefined;
}

/** In order of precedence: the first expression found in the text wins. */
const DATE_MATCHERS: DateMatcher[] = [
  isoDate,
  numericDateWithYear,
  dayWithMonthName,
  numericDateWithoutYear,
  namedDay,
  countedOffset,
  weekdayDate,
  nextWeekOrMonth,
  monthWithYear,
];

/** First date in a German text as ISO (YYYY-MM-DD) or null; relative expressions refer to the local day of `now`. */
export function parseGermanDate(input: string, now: Date = new Date()): string | null {
  const context = { text: input.toLowerCase(), input, today: new Date(now.getFullYear(), now.getMonth(), now.getDate()) };
  for (const matcher of DATE_MATCHERS) {
    const match = matcher(context);
    if (match) return match.date;
  }
  return null;
}

/** Normalizes a date returned by the LLM (ISO or German) to ISO or null. */
export function normalizeDateInput(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) {
    const iso = validDate(Number(trimmed.slice(0, 4)), Number(trimmed.slice(5, 7)), Number(trimmed.slice(8, 10)));
    return iso ? (trimmed.length > 10 ? trimmed : iso) : null;
  }
  return parseGermanDate(trimmed, now);
}

/** Decision date from German text: a decision lies in the past, so weekdays and yearless dates point back; a future date is null (#168). */
export function parseDecisionDate(input: string, now: Date = new Date()): string | null {
  const text = input.toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = !LAST_WEEKDAY_RE.test(text) && !NEXT_WEEKDAY_RE.test(text) ? (AM_WEEKDAY_RE.exec(text) ?? BARE_WEEKDAY_RE.exec(text)) : null;
  const parsed = weekday && !/\d/.test(text) ? toIsoDate(previousWeekday(today, WEEKDAYS[weekday[1]!]!)) : parseGermanDate(input, now);
  // only „12. Juni“ / „12.6.“ (no year) can mean last year; „morgen“ or „2027“ in the future is no decision date
  return pastOrNull(parsed, { today, yearGiven: !isYearless(text) });
}

/** Like normalizeDateInput, for a decision date: never in the future (see parseDecisionDate). */
export function normalizeDecisionDate(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed))
    return pastOrNull(normalizeDateInput(trimmed, now), { today: new Date(now.getFullYear(), now.getMonth(), now.getDate()), yearGiven: true });
  return parseDecisionDate(trimmed, now);
}

/** „12. Juni“ / „3.10.“ – a day and month without a year („3.10.26“ and „2026“ have one). */
function isYearless(text: string): boolean {
  return !/\b\d{4}\b|\b\d{1,2}\.\s?\d{1,2}\.\s?\d{2}\b/.test(text) && /\b\d{1,2}\.\s?(?:\d{1,2}\.|[a-zäöü]{3,})/.test(text);
}

/** A due date („bis 15.1.“): without a year it is the next such day, never one that has already passed. */
export function normalizeDueDate(value: string | null | undefined, now: Date = new Date()): string | null {
  const iso = normalizeDateInput(value, now);
  if (!iso || !value) return iso;
  if (!isYearless(value.toLowerCase()) || iso.slice(0, 10) >= toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()))) return iso;
  return validDate(Number(iso.slice(0, 4)) + 1, Number(iso.slice(5, 7)), Number(iso.slice(8, 10))) ?? iso;
}

/** A date after today: the same day one year earlier if the year was not given, otherwise null. */
function pastOrNull(iso: string | null, reference: { today: Date; yearGiven: boolean }): string | null {
  if (!iso || iso.slice(0, 10) <= toIsoDate(reference.today)) return iso;
  if (reference.yearGiven) return null;
  return validDate(Number(iso.slice(0, 4)) - 1, Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
}
