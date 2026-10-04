/** Runs `run` over `items` in order, at most `limit` at a time; returns the errors (one failing item does not stop the others). */
export async function runBounded<T>(
  items: readonly T[],
  options: { limit: number; start?: number; onBatchDone?: (done: number) => void },
  run: (item: T) => Promise<void>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (let offset = options.start ?? 0; offset < items.length; offset += options.limit) {
    const batch = items.slice(offset, offset + options.limit);
    const settled = await Promise.allSettled(batch.map(run));
    for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
    options.onBatchDone?.(offset + batch.length);
  }
  return errors;
}
