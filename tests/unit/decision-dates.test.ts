import { describe, expect, it } from 'vitest';
import { normalizeDecisionDate, normalizeDueDate, parseDecisionDate } from '../../packages/core/src/util/dates';
import { classifyLocally, pastOrToday } from '../../packages/core/src/services/classifier';

// Friday, 2 October 2026
const NOW = new Date(2026, 9, 2, 12, 0);

describe('Decision dates lie in the past (#168)', () => {
  it('a bare weekday is the last one, not the next', () => {
    expect(parseDecisionDate('Montag', NOW)).toBe('2026-09-28');
    expect(parseDecisionDate('am Freitag', NOW)).toBe('2026-09-25');
    expect(parseDecisionDate('letzten Dienstag', NOW)).toBe('2026-09-29');
  });

  it('a day without a year is the last such day; an explicit future date is rejected', () => {
    expect(parseDecisionDate('3. Dezember', NOW)).toBe('2025-12-03');
    expect(parseDecisionDate('12.6.', NOW)).toBe('2026-06-12');
    expect(parseDecisionDate('3.10.', NOW)).toBe('2025-10-03');
    expect(parseDecisionDate('3.10.26', NOW)).toBeNull();
    expect(parseDecisionDate('3. Dezember 2026', NOW)).toBeNull();
    expect(parseDecisionDate('morgen', NOW)).toBeNull();
    expect(parseDecisionDate('nächsten Montag', NOW)).toBeNull();
    expect(normalizeDecisionDate('2027-01-01', NOW)).toBeNull();
    expect(normalizeDecisionDate('2026-09-30', NOW)).toBe('2026-09-30');
    expect(normalizeDecisionDate('gestern', NOW)).toBe('2026-10-01');
  });
});

describe('Document date (#168)', () => {
  it('is the first date in the text that is not in the future', () => {
    const local = classifyLocally({
      fileName: 'brief.txt',
      ext: 'txt',
      text: 'Frist bis 15.12.2026.\nBerlin, den 14.08.2025\nSehr geehrte Damen und Herren, am 01.07.2025 …',
      knownTopics: [],
      knownProjects: [],
      now: NOW,
    });
    expect(local.documentDate).toBe('2025-08-14');
    expect(pastOrToday('2026-10-03', NOW)).toBeNull();
    expect(pastOrToday('2026-10-02T09:00:00Z', NOW)).toBe('2026-10-02');
  });
});

describe('Due dates lie ahead (#307)', () => {
  it('a day without a year is the next such day; with a year or relative it stays as given', () => {
    expect(normalizeDueDate('15.1.', NOW)).toBe('2027-01-15');
    expect(normalizeDueDate('31.10.', NOW)).toBe('2026-10-31');
    expect(normalizeDueDate('2. Oktober', NOW)).toBe('2026-10-02');
    expect(normalizeDueDate('15.1.2026', NOW)).toBe('2026-01-15');
    expect(normalizeDueDate('2026-01-15', NOW)).toBe('2026-01-15');
    expect(normalizeDueDate('morgen', NOW)).toBe('2026-10-03');
    expect(normalizeDueDate('irgendwann', NOW)).toBeNull();
    expect(normalizeDueDate(null, NOW)).toBeNull();
  });
});
