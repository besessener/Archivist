import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntervalSchedule, memoryLastRunStore } from '../../packages/core/src/services/scheduler';

const MIN = 60_000;
const DAY = 86_400_000;

describe('IntervalSchedule', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs only after start() and then once per interval', () => {
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run });
    s.setInterval(10 * MIN);
    vi.advanceTimersByTime(30 * MIN);
    expect(run).not.toHaveBeenCalled();
    expect(s.nextRunAt()).toBeNull();

    s.start();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20 * MIN);
    expect(run).toHaveBeenCalledTimes(3);

    s.stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('re-applying the same interval keeps the pending timer', () => {
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run });
    s.setInterval(10 * MIN);
    s.start();
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(MIN);
      s.setInterval(10 * MIN);
    }
    vi.advanceTimersByTime(MIN);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a changed interval takes effect immediately, measured from the last run', () => {
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run });
    s.setInterval(60 * MIN);
    s.start();
    vi.advanceTimersByTime(60 * MIN);
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20 * MIN);
    s.setInterval(30 * MIN);
    expect(s.nextRunAt()).toBe(Date.now() + 10 * MIN);
    vi.advanceTimersByTime(10 * MIN);
    expect(run).toHaveBeenCalledTimes(2);

    // already overdue under the new, shorter interval: runs right away
    vi.advanceTimersByTime(20 * MIN);
    s.setInterval(15 * MIN);
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('null or 0 disables the schedule; enabling again counts from that moment', () => {
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run });
    s.start();
    s.setInterval(10 * MIN);
    vi.advanceTimersByTime(5 * MIN);
    s.setInterval(0);
    expect(s.nextRunAt()).toBeNull();
    vi.advanceTimersByTime(60 * MIN);
    expect(run).not.toHaveBeenCalled();

    s.setInterval(10 * MIN);
    expect(s.nextRunAt()).toBe(Date.now() + 10 * MIN);
    s.setInterval(null);
    vi.advanceTimersByTime(60 * MIN);
    expect(run).not.toHaveBeenCalled();
  });

  it('markRun() postpones the next run', () => {
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run });
    s.setInterval(10 * MIN);
    s.start();
    vi.advanceTimersByTime(8 * MIN);
    s.markRun();
    vi.advanceTimersByTime(9 * MIN);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses the last run from its store and writes every run back', () => {
    const store = memoryLastRunStore(Date.now() - 50 * MIN);
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run, lastRun: store });
    s.setInterval(60 * MIN);
    s.start();
    expect(s.nextRunAt()).toBe(Date.now() + 10 * MIN);
    vi.advanceTimersByTime(10 * MIN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(Date.now());
  });

  it('handles intervals longer than setTimeout allows', () => {
    const run = vi.fn();
    const s = new IntervalSchedule({ name: 'test', run });
    s.setInterval(40 * DAY);
    s.start();
    vi.advanceTimersByTime(30 * DAY);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * DAY);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failing run is logged and does not stop the schedule', () => {
    const warn = vi.fn();
    const run = vi.fn(() => {
      throw new Error('boom');
    });
    const s = new IntervalSchedule({ name: 'test', run, logger: { warn } as never });
    s.setInterval(10 * MIN);
    s.start();
    vi.advanceTimersByTime(20 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
