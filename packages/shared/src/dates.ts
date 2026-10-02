// Local-time helpers (#77): days follow the user's zone, never UTC; without an explicit zone the process or browser zone applies.

/** Time of day `HH:MM` (24 h), e.g. `08:00`. */
export const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Calendar day without a time, e.g. `2026-10-01`. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Date with a wall-clock time, optionally followed by a zone designator. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

let defaultTimeZone: string | null = null;

/** Default zone for calls without one (null: process zone); worker threads need it because their copied `TZ` never reaches ICU. */
export function setDefaultTimeZone(timeZone: string | null): void {
  if (timeZone !== null) formatter(timeZone); // validates the zone
  defaultTimeZone = timeZone;
}

/** The IANA time zone used by default: the one set via `setDefaultTimeZone`, otherwise that of the process (or browser). */
export function currentTimeZone(): string {
  return defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in the given zone. */
function wallClock(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Offset of the zone at the given instant, in milliseconds (Berlin in summer: +2 h). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const floored = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floored;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local day (`YYYY-MM-DD`): date-only values stay, zoned timestamps are converted, wall-clock times count as local. */
export function localDate(value: string | Date, timeZone: string = currentTimeZone()): string {
  if (typeof value === 'string') {
    if (DATE_ONLY.test(value)) return value;
    const m = DATE_TIME.exec(value);
    if (m && !m[7]) return value.slice(0, 10);
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return value.slice(0, 10);
    return localDate(new Date(ms), timeZone);
  }
  const w = wallClock(value.getTime(), timeZone);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** Today's local calendar day (`YYYY-MM-DD`). */
export function localToday(now: Date = new Date(), timeZone: string = currentTimeZone()): string {
  return localDate(now, timeZone);
}

/** Instant of a local wall-clock time; a time in the spring-forward gap resolves to the time after the switch. */
export function localDateTime(day: string, time: string, timeZone: string = currentTimeZone()): Date {
  const d = DATE_ONLY.exec(day);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) throw new RangeError(`Ungültige Ortszeit: ${day} ${time}`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  const first = wall - zoneOffsetMs(wall, timeZone);
  const second = wall - zoneOffsetMs(first, timeZone);
  return new Date(second);
}

/** Instant of a value as a point in time: a date-only value means `defaultTime` local time that day; null if unparsable. */
export function localInstant(value: string, defaultTime: string, timeZone: string = currentTimeZone()): Date | null {
  if (DATE_ONLY.test(value)) return localDateTime(value, defaultTime, timeZone);
  const m = DATE_TIME.exec(value);
  if (m && !m[7]) return localDateTime(value.slice(0, 10), `${m[4]}:${m[5]}:${m[6] ?? '00'}`, timeZone);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
