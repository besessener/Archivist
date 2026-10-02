/**
 * Quitting the app without hanging: shutdown gets a hard deadline, and a start of the app while it is still
 * quitting is not lost but relaunches it once it has exited. Kept free of Electron so it can be unit-tested.
 */

/** How long running jobs may take to stop after they were interrupted on quit. */
export const JOB_INTERRUPT_TIMEOUT_MS = 5_000;
/** The process exits at the latest this long after quitting started, even if shutdown hangs. */
export const QUIT_DEADLINE_MS = 10_000;

export interface QuitDeps {
  /** Stops background work and closes the database. */
  shutdown(): Promise<void>;
  /** Ends the process (Electron: `app.exit`). Called exactly once. */
  exit(code: number): void;
  /** Starts a new instance once this one has exited (Electron: `app.relaunch`). */
  relaunch(): void;
  /** Reports a failed or overdue shutdown (the process exits anyway). */
  log?(message: string, error?: unknown): void;
  deadlineMs?: number;
}

export class QuitController {
  private started = false;
  private relaunchRequested = false;
  private exited = false;

  constructor(private readonly deps: QuitDeps) {}

  /** True once quitting has started. */
  get quitting(): boolean {
    return this.started;
  }

  /**
   * Starts quitting (later calls do nothing): runs shutdown and exits afterwards, but at the latest after the
   * deadline. Resolves once `exit` was called.
   */
  quit(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    const deadlineMs = this.deps.deadlineMs ?? QUIT_DEADLINE_MS;
    return new Promise<void>((resolve) => {
      const finish = (code: number) => {
        clearTimeout(timer);
        this.exit(code);
        resolve();
      };
      const timer = setTimeout(() => {
        this.deps.log?.(`Beenden dauerte länger als ${Math.round(deadlineMs / 1000)} s – Prozess wird beendet.`);
        finish(0);
      }, deadlineMs);
      this.deps.shutdown().then(
        () => finish(0),
        (err: unknown) => {
          this.deps.log?.('Fehler beim Beenden', err);
          finish(0);
        },
      );
    });
  }

  /**
   * The app was started again while this instance is quitting (the new instance found the single-instance lock
   * still held and gave up): start it anew once this instance has exited.
   */
  requestRelaunch(): void {
    this.relaunchRequested = true;
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    if (this.relaunchRequested) this.deps.relaunch();
    this.deps.exit(code);
  }
}
