import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { readTasks, type ReadTaskName } from './read-tasks';

// Read worker entry (bundled into db-reader.cjs): own read-only WAL connection, so long queries never block the main thread (#215).
if (!parentPort) throw new Error('db-reader-entry must run in a worker thread');
const port = parentPort;
const sqlite = new Database((workerData as { file: string }).file, { readonly: true, fileMustExist: true });
sqlite.pragma('busy_timeout = 5000');
const db = drizzle(sqlite, { schema });

port.on('message', (message: { id: number; task: ReadTaskName; payload: never }) => {
  try {
    const readTask = readTasks[message.task] as ((database: typeof db, payload: never) => unknown) | undefined;
    if (!readTask) throw new Error(`Unbekannte Leseabfrage: ${String(message.task)}`);
    port.postMessage({ id: message.id, ok: true, result: readTask(db, message.payload) });
  } catch (err) {
    port.postMessage({ id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
