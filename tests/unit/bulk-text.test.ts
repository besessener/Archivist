import { describe, expect, it } from 'vitest';
import { estimateTokens, formatRemaining, progressLine, runSummary } from '../../packages/core/src/util/bulk-text';

describe('Bulk run texts', () => {
  it('estimates about one token per four characters, rounding up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(-5)).toBe(0);
  });

  it('formats the remaining time', () => {
    expect(formatRemaining(20_000)).toBe('weniger als 1 Min.');
    expect(formatRemaining(5 * 60_000)).toBe('ca. 5 Min.');
    expect(formatRemaining(60 * 60_000)).toBe('ca. 1 Std.');
    expect(formatRemaining((2 * 60 + 5) * 60_000)).toBe('ca. 2 Std. 5 Min.');
  });

  it('writes the progress line with thousands separators and the remaining time', () => {
    expect(progressLine({ done: 4300, total: 20_000, elapsedMs: 4300 * 1000 })).toBe('4.300 von 20.000 analysiert, ca. 4 Std. 22 Min. verbleibend');
  });

  it('gives no estimate before a few items are finished or when everything is done', () => {
    expect(progressLine({ done: 2, total: 100, elapsedMs: 5000 })).toBe('2 von 100 analysiert');
    expect(progressLine({ done: 100, total: 100, elapsedMs: 5000 })).toBe('100 von 100 analysiert');
    expect(progressLine({ done: 50, total: 100, elapsedMs: 0 })).toBe('50 von 100 analysiert');
  });

  it('bases the estimate on the items of this run when a run was resumed', () => {
    expect(progressLine({ done: 1000, total: 1100, elapsedMs: 10_000, sampled: 10, verb: 'neu verarbeitet' })).toBe(
      '1.000 von 1.100 neu verarbeitet, ca. 2 Min. verbleibend',
    );
  });

  it('writes the one notification text of a run', () => {
    expect(runSummary({ done: 12, failed: 2 })).toBe('12 Dokumente analysiert, 2 Fehler');
    expect(runSummary({ done: 1, failed: 1 })).toBe('1 Dokument analysiert, 1 Fehler');
    expect(runSummary({ done: 0, failed: 0, verb: 'importiert' })).toBe('0 Dokumente importiert, 0 Fehler');
  });
});
