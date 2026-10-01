/**
 * Local-time helpers shared by core and renderer (#77).
 *
 * "Today", "overdue" and timeline days follow the user's local time zone, never UTC.
 * Every function takes an optional IANA time zone; without it the process/browser zone is used.
 * Tests pass an explicit zone so they do not depend on the machine they run on.
 */

/** Time of day `HH:MM` (24 h), e.g. `08:00`. */
export const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Calendar day without a time, e.g. `2026-10-01`. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Date with a wall-clock time, optionally followed by a zone designator. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** The IANA time zone of the running process (or browser). */
export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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

/**
 * Local calendar day (`YYYY-MM-DD`) of a date or timestamp.
 * - Date-only values (`2026-10-01`) are already local days and stay unchanged.
 * - Timestamps with a zone (`2026-09-30T22:30:00Z`) are converted to the local day (Berlin: 2026-10-01).
 * - Wall-clock times without a zone (`2026-10-01T09:00`) are taken as local time.
 */
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

/**
 * The instant of a local wall-clock time, e.g. `2026-10-05` at `08:00` in Europe/Berlin → 2026-10-05T06:00:00Z.
 * A time that does not exist (spring-forward gap) resolves to the corresponding time after the switch.
 */
export function localDateTime(day: string, time: string, timeZone: string = currentTimeZone()): Date {
  const d = DATE_ONLY.exec(day);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) throw new RangeError(`Ungültige Ortszeit: ${day} ${time}`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  const first = wall - zoneOffsetMs(wall, timeZone);
  const second = wall - zoneOffsetMs(first, timeZone);
  return new Date(second);
}

/**
 * The instant a date or timestamp stands for when used as a point in time (e.g. a reminder):
 * date-only values mean `defaultTime` local time on that day, wall-clock times without a zone mean local time,
 * timestamps with a zone are taken as they are. Returns null for unparsable values.
 */
export function localInstant(value: string, defaultTime: string, timeZone: string = currentTimeZone()): Date | null {
  if (DATE_ONLY.test(value)) return localDateTime(value, defaultTime, timeZone);
  const m = DATE_TIME.exec(value);
  if (m && !m[7]) return localDateTime(value.slice(0, 10), `${m[4]}:${m[5]}:${m[6] ?? '00'}`, timeZone);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
