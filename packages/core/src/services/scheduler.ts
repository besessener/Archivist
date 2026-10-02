import type { Logger } from '../util/logger';

/** Where a schedule keeps the time (epoch ms) of its last run; a persistent store lets the rhythm survive restarts. */
export interface LastRunStore {
  get(): number | null;
  set(at: number): void;
}

export function memoryLastRunStore(initial: number | null = null): LastRunStore {
  let value = initial;
  return {
    get: () => value,
    set: (at) => {
      value = at;
    },
  };
}

/** Longest delay setTimeout accepts (about 24.8 days); longer waits are split into several timeouts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface IntervalScheduleOptions {
  /** Short name for log entries */
  name: string;
  /** Starts the periodic work (usually enqueues a job); must not block */
  run: () => void;
  logger?: Logger;
  lastRun?: LastRunStore;
}

/** Recurring task while the app runs, due one interval after the last run; re-applying an unchanged interval keeps the timer. */
export class IntervalSchedule {
  private intervalMs: number | null = null;
  private started = false;
  private anchor = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private readonly lastRun: LastRunStore;

  constructor(private readonly options: IntervalScheduleOptions) {
    this.lastRun = options.lastRun ?? memoryLastRunStore();
  }

  /** Arms the timer for the current interval (if any). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.anchor = Date.now();
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.clear();
  }

  /** Sets the interval; null, 0 or a negative value disables the schedule. No-op when unchanged. */
  setInterval(ms: number | null): void {
    const next = ms !== null && Number.isFinite(ms) && ms > 0 ? ms : null;
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    this.anchor = Date.now();
    this.arm();
  }

  /** Records a run that happened outside the schedule (e.g. manual or on startup); the next run moves accordingly. */
  markRun(at = Date.now()): void {
    this.lastRun.set(at);
    this.arm();
  }

  /** When the next run is due, or null while stopped or disabled. */
  nextRunAt(): number | null {
    if (!this.started || this.intervalMs === null) return null;
    return (this.lastRun.get() ?? this.anchor) + this.intervalMs;
  }

  private arm(): void {
    this.clear();
    const due = this.nextRunAt();
    if (due === null) return;
    const delay = Math.min(Math.max(0, due - Date.now()), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    const due = this.nextRunAt();
    if (due === null) return;
    if (Date.now() >= due) {
      this.lastRun.set(Date.now());
      try {
        this.options.run();
      } catch (err) {
        this.options.logger?.warn('scheduler', 'Scheduled task not started', { schedule: this.options.name, error: err });
      }
    }
    // the run may have changed the schedule (markRun, stop); arm() picks up the current state
    if (this.started && !this.timer) this.arm();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
