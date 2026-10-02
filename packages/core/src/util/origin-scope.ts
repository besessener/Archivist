import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityType } from '@archivist/shared';

/** An entry created inside a scope (decision, open item, event, note). */
export interface CreatedEntry {
  id: string;
  type: EntityType;
}

const storage = new AsyncLocalStorage<CreatedEntry[]>();

/** Collects the entries created while `fn` runs, to link them with each other (#272); filled even when `fn` fails. */
export async function collectCreated<T>(fn: () => Promise<T>, into: CreatedEntry[]): Promise<T> {
  return storage.run(into, fn);
}

/** Called by the services that create entries (via `EventBus.created`). */
export function noteCreated(entry: CreatedEntry): void {
  storage.getStore()?.push(entry);
}
