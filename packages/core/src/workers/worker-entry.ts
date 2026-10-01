import { parentPort } from 'node:worker_threads';
import { tasks, type TaskName } from './tasks';

/** Einstiegspunkt der Worker-Threads (wird per esbuild zu worker.cjs gebündelt). */
if (!parentPort) throw new Error('worker-entry muss in einem Worker-Thread laufen');
const port = parentPort;

port.on('message', async (msg: { id: number; task: TaskName; payload: never }) => {
  try {
    const fn = tasks[msg.task] as ((p: never) => Promise<unknown>) | undefined;
    if (!fn) throw new Error(`Unbekannte Aufgabe: ${String(msg.task)}`);
    const result = await fn(msg.payload);
    port.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err), code: (err as NodeJS.ErrnoException)?.code });
  }
});
