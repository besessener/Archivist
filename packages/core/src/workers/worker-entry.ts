import { parentPort } from 'node:worker_threads';
import { tasks, type TaskName } from './tasks';

/** Entry point of the worker threads (bundled into worker.cjs by esbuild). */
if (!parentPort) throw new Error('worker-entry must run in a worker thread');
const port = parentPort;

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler catches all errors itself and answers via postMessage
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
