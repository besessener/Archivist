import { describe, expect, it } from 'vitest';
import { runBounded } from '../../packages/core/src/util/bounded';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runBounded', () => {
  it('never runs more than `limit` items at the same time, and runs them all', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];

    await runBounded([1, 2, 3, 4, 5, 6, 7], { limit: 3 }, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
      done.push(item);
    });

    expect(peak).toBe(3);
    expect(done.toSorted()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('collects the errors and keeps going', async () => {
    const done: number[] = [];

    const errors = await runBounded([1, 2, 3, 4], { limit: 2 }, async (item) => {
      if (item === 2) throw new Error('zwei');
      done.push(item);
    });

    expect(errors).toEqual([new Error('zwei')]);
    expect(done).toEqual([1, 3, 4]);
  });

  it('starts at the given offset and reports the number of finished items after every batch', async () => {
    const seen: number[] = [];
    const progress: number[] = [];

    await runBounded([1, 2, 3, 4, 5], { limit: 2, start: 2, onBatchDone: (done) => progress.push(done) }, async (item) => void seen.push(item));

    expect(seen).toEqual([3, 4, 5]);
    expect(progress).toEqual([4, 5]);
  });

  it('does nothing for an empty list', async () => {
    expect(await runBounded([], { limit: 2 }, async () => undefined)).toEqual([]);
  });
});
