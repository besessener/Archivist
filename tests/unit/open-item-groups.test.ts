import { describe, expect, it } from 'vitest';
import { dueWindow, groupOf } from '../../apps/renderer/lib/open-item-groups';
import type { OpenItemRecord } from '../../apps/renderer/lib/types';

const noon = new Date(2026, 9, 7, 12);
const item = (patch: Partial<OpenItemRecord>) => ({ status: 'open', dueAt: null, ...patch }) as OpenItemRecord;

describe('groupOf', () => {
  it('uses the configured number of days for „Bald fällig“', () => {
    const week = dueWindow(7, noon);
    const threeDays = dueWindow(3, noon);
    expect(groupOf(item({ dueAt: '2026-10-14' }), week)).toBe('due');
    expect(groupOf(item({ dueAt: '2026-10-14' }), threeDays)).toBe('open');
    expect(groupOf(item({ dueAt: '2026-10-10' }), threeDays)).toBe('due');
    expect(groupOf(item({ dueAt: '2026-10-11' }), threeDays)).toBe('open');
  });

  it('keeps today due and yesterday overdue, closed and undated items aside', () => {
    const window = dueWindow(7, noon);
    expect(groupOf(item({ dueAt: '2026-10-07' }), window)).toBe('due');
    expect(groupOf(item({ dueAt: '2026-10-06' }), window)).toBe('overdue');
    expect(groupOf(item({}), window)).toBe('open');
    expect(groupOf(item({ status: 'resolved', dueAt: '2026-10-06' }), window)).toBe('done');
  });
});
