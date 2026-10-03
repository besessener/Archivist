/** Pending jobs waiting for their next attempt (kept in memory only) and the timer that wakes the queue for them. */
export class RetryWaits {
  /** job id → earliest start (epoch ms) */
  private readonly earliestStart = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  get size(): number {
    return this.earliestStart.size;
  }

  set(id: string, at: number): void {
    this.earliestStart.set(id, at);
  }

  delete(id: string): void {
    this.earliestStart.delete(id);
  }

  isDue(id: string, now: number): boolean {
    return (this.earliestStart.get(id) ?? 0) <= now;
  }

  /** Wakes the queue when the earliest wait after `now` ends; waits due at `now` need no timer (the queue just looked). */
  schedule(now: number, wake: () => void): void {
    this.clearTimer();
    const upcoming = [...this.earliestStart.values()].filter((at) => at > now);
    if (!upcoming.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        wake();
      },
      Math.min(...upcoming) - now,
    );
    this.timer.unref?.();
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
