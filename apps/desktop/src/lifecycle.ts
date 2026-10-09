// Quitting without hanging (hard deadline, relaunch requests are kept); free of Electron so it can be unit-tested.

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
  private beforeExit: (() => void)[] = [];

  constructor(private readonly deps: QuitDeps) {}

  /** True once quitting has started. */
  get quitting(): boolean {
    return this.started;
  }

  /** Runs shutdown once and exits afterwards, at the latest after the deadline; resolves once `exit` was called. */
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
        this.deps.log?.(`Quitting took longer than ${Math.round(deadlineMs / 1000)} s – exiting the process.`);
        finish(0);
      }, deadlineMs);
      this.deps.shutdown().then(
        () => finish(0),
        (err: unknown) => {
          this.deps.log?.('Error while quitting', err);
          finish(0);
        },
      );
    });
  }

  /** A second start while quitting gave up on the single-instance lock: relaunch once this instance has exited. */
  requestRelaunch(): void {
    this.relaunchRequested = true;
  }

  /** Runs `hook` right before the process exits, e.g. to start the update installer once the database is closed. */
  runBeforeExit(hook: () => void): void {
    this.beforeExit.push(hook);
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const hook of this.beforeExit) {
      try {
        hook();
      } catch (err) {
        this.deps.log?.('Error right before exiting', err);
      }
    }
    if (this.relaunchRequested) this.deps.relaunch();
    this.deps.exit(code);
  }
}
