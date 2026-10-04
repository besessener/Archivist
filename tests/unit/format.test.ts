import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as FormatModule from '../../apps/renderer/lib/format';

const originalTimeZone = process.env.TZ;
let format: typeof FormatModule;

describe('date formatting', () => {
  beforeAll(async () => {
    // west of UTC a plain date parsed as UTC midnight would show the previous day
    process.env.TZ = 'America/New_York';
    format = await import('../../apps/renderer/lib/format');
  });

  afterAll(() => {
    process.env.TZ = originalTimeZone;
  });

  it('shows a plain date as that local day, without a time zone shift', () => {
    expect(format.formatDate('2026-03-01')).toBe('01.03.2026');
    expect(format.formatLongDate('2026-03-01')).toBe('1. März 2026');
  });

  it('keeps the fallback for empty and invalid values', () => {
    expect(format.formatDate(null)).toBe('–');
    expect(format.formatDate('kein Datum', '?')).toBe('?');
  });
});
