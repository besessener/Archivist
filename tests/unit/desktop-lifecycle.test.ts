import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuitController, QUIT_DEADLINE_MS } from '../../apps/desktop/src/lifecycle';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(shutdown: () => Promise<void>) {
  const calls: string[] = [];
  const log = vi.fn();
  const quitter = new QuitController({
    shutdown,
    exit: (code) => calls.push(`exit:${code}`),
    relaunch: () => calls.push('relaunch'),
    log,
    deadlineMs: 1_000,
  });
  return { quitter, calls, log };
}

describe('Beenden der Anwendung', () => {
  it('beendet den Prozess nach dem Herunterfahren genau einmal', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const { quitter, calls } = setup(shutdown);
    expect(quitter.quitting).toBe(false);
    const done = quitter.quit();
    expect(quitter.quitting).toBe(true);
    void quitter.quit(); // a second quit request changes nothing
    await done;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['exit:0']);
  });

  it('beendet den Prozess spätestens nach der Frist, auch wenn das Herunterfahren hängt', async () => {
    const { quitter, calls, log } = setup(() => new Promise<void>(() => undefined));
    const done = quitter.quit();
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toEqual(['exit:0']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('länger als 1 s'));
  });

  it('beendet den Prozess auch, wenn das Herunterfahren fehlschlägt', async () => {
    const { quitter, calls, log } = setup(() => Promise.reject(new Error('kaputt')));
    await quitter.quit();
    expect(calls).toEqual(['exit:0']);
    expect(log).toHaveBeenCalledWith('Fehler beim Beenden', expect.any(Error));
  });

  it('startet neu, wenn die Anwendung während des Beendens erneut gestartet wurde', async () => {
    let finish!: () => void;
    const { quitter, calls } = setup(() => new Promise<void>((r) => (finish = r)));
    const done = quitter.quit();
    quitter.requestRelaunch();
    finish();
    await done;
    expect(calls).toEqual(['relaunch', 'exit:0']);
  });

  it('hat eine Standardfrist von höchstens zehn Sekunden', () => {
    expect(QUIT_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });
});
