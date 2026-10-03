import { parentPort } from 'node:worker_threads';
import { tasks, type TaskName } from './tasks';

/** Entry point of the worker threads (bundled into worker.cjs by esbuild). */
if (!parentPort) throw new Error('worker-entry must run in a worker thread');
const port = parentPort;

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler catches all errors itself and answers via postMessage
port.on('message', async (message: { id: number; task: TaskName; payload: never }) => {
  try {
    const task = tasks[message.task] as ((payload: never) => Promise<unknown>) | undefined;
    if (!task) throw new Error(`Unbekannte Aufgabe: ${String(message.task)}`);
    const result = await task(message.payload);
    port.postMessage({ id: message.id, ok: true, result });
  } catch (err) {
    port.postMessage({ id: message.id, ok: false, error: err instanceof Error ? err.message : String(err), code: (err as NodeJS.ErrnoException)?.code });
  }
});
