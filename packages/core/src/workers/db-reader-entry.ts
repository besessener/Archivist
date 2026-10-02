import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { readTasks, type ReadTaskName } from './read-tasks';

/**
 * Entry point of the read worker (bundled into db-reader.cjs by esbuild): its own read-only connection to the
 * database (WAL: it reads the last committed state while the main process writes), so long queries do not block
 * the Electron main thread (#215).
 */
if (!parentPort) throw new Error('db-reader-entry must run in a worker thread');
const port = parentPort;
const sqlite = new Database((workerData as { file: string }).file, { readonly: true, fileMustExist: true });
sqlite.pragma('busy_timeout = 5000');
const db = drizzle(sqlite, { schema });

port.on('message', (msg: { id: number; task: ReadTaskName; payload: never }) => {
  try {
    const fn = readTasks[msg.task] as ((d: typeof db, p: never) => unknown) | undefined;
    if (!fn) throw new Error(`Unbekannte Leseabfrage: ${String(msg.task)}`);
    port.postMessage({ id: msg.id, ok: true, result: fn(db, msg.payload) });
  } catch (err) {
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
