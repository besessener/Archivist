const POLL_INTERVAL_MS = 15;

/** Reads `read` every few milliseconds until `done` holds or `timeoutMs` has passed; returns the last value read and whether it is done. */
export async function pollUntil<T>(
  read: () => T,
  { done, timeoutMs }: { done: (value: T) => boolean; timeoutMs: number },
): Promise<{ value: T; done: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (done(value)) return { value, done: true };
    if (Date.now() > deadline) return { value, done: false };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
