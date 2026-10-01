import { describe, expect, it } from 'vitest';
import { currentTimeZone, localDate, localDateTime, localInstant, localToday, setDefaultTimeZone } from '@archivist/shared';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';

describe('localDate / localToday (#77)', () => {
  it('keeps date-only values unchanged in every time zone', () => {
    expect(localDate('2026-10-01', BERLIN)).toBe('2026-10-01');
    expect(localDate('2026-10-01', NEW_YORK)).toBe('2026-10-01');
  });

  it('puts timestamps shortly after local midnight on the local day, not the UTC day', () => {
    // 00:30 summer time in Berlin is still 22:30 of the previous day in UTC
    expect(localDate('2026-09-30T22:30:00.000Z', BERLIN)).toBe('2026-10-01');
    expect(localDate('2026-09-30T22:30:00.000Z', 'UTC')).toBe('2026-09-30');
    // 23:30 in Berlin stays on the same day
    expect(localDate('2026-10-01T21:30:00Z', BERLIN)).toBe('2026-10-01');
    // New York is behind UTC: 01:30 UTC is still the previous evening
    expect(localDate('2026-10-02T01:30:00Z', NEW_YORK)).toBe('2026-10-01');
    // winter time (UTC+1)
    expect(localDate('2026-12-24T23:15:00Z', BERLIN)).toBe('2026-12-25');
  });

  it('honours explicit offsets and treats wall-clock times without a zone as local', () => {
    expect(localDate('2026-10-01T00:30:00+02:00', 'UTC')).toBe('2026-09-30');
    expect(localDate('2026-10-01T00:30', NEW_YORK)).toBe('2026-10-01');
    expect(localDate('2026-10-01 23:59:59', BERLIN)).toBe('2026-10-01');
  });

  it('accepts Date objects and computes today around midnight', () => {
    const justAfterMidnight = new Date('2026-09-30T22:05:00Z');
    expect(localToday(justAfterMidnight, BERLIN)).toBe('2026-10-01');
    expect(localToday(justAfterMidnight, NEW_YORK)).toBe('2026-09-30');
    expect(localDate(new Date('2026-09-30T21:59:59Z'), BERLIN)).toBe('2026-09-30');
  });
});

describe('localDateTime / localInstant (#77)', () => {
  it('converts a local wall-clock time to the right instant in summer and winter', () => {
    expect(localDateTime('2026-10-05', '08:00', BERLIN).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(localDateTime('2026-12-05', '08:00', BERLIN).toISOString()).toBe('2026-12-05T07:00:00.000Z');
    expect(localDateTime('2026-10-05', '08:00', NEW_YORK).toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(localDateTime('2026-10-05', '00:00', BERLIN).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  });

  it('handles the days of the clock change', () => {
    // spring forward: 02:30 does not exist and resolves to 03:30 summer time
    expect(localDateTime('2026-03-29', '02:30', BERLIN).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(localDateTime('2026-03-29', '08:00', BERLIN).toISOString()).toBe('2026-03-29T06:00:00.000Z');
    expect(localDateTime('2026-10-25', '08:00', BERLIN).toISOString()).toBe('2026-10-25T07:00:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(() => localDateTime('01.10.2026', '08:00', BERLIN)).toThrow(RangeError);
    expect(() => localDateTime('2026-10-01', '8 Uhr', BERLIN)).toThrow(RangeError);
  });

  it('gives date-only values the default time and keeps timestamps', () => {
    expect(localInstant('2026-10-05', '08:00', BERLIN)?.toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(localInstant('2026-10-05', '07:30', NEW_YORK)?.toISOString()).toBe('2026-10-05T11:30:00.000Z');
    expect(localInstant('2026-10-05T14:15', '08:00', BERLIN)?.toISOString()).toBe('2026-10-05T12:15:00.000Z');
    expect(localInstant('2026-10-05T14:15:00Z', '08:00', BERLIN)?.toISOString()).toBe('2026-10-05T14:15:00.000Z');
    expect(localInstant('kein Datum', '08:00', BERLIN)).toBeNull();
  });
});

describe('setDefaultTimeZone (#77)', () => {
  it('overrides the process zone until reset and rejects unknown zones', () => {
    const processZone = currentTimeZone();
    try {
      setDefaultTimeZone('Europe/Berlin');
      expect(currentTimeZone()).toBe('Europe/Berlin');
      expect(localDate('2026-09-30T22:30:00Z')).toBe('2026-10-01');
      setDefaultTimeZone('America/New_York');
      expect(localToday(new Date('2026-10-02T01:30:00Z'))).toBe('2026-10-01');
      expect(localDateTime('2026-10-05', '08:00').toISOString()).toBe('2026-10-05T12:00:00.000Z');
      expect(() => setDefaultTimeZone('Mars/Olympus')).toThrow(RangeError);
      expect(currentTimeZone()).toBe('America/New_York');
    } finally {
      setDefaultTimeZone(null);
    }
    expect(currentTimeZone()).toBe(processZone);
  });
});
