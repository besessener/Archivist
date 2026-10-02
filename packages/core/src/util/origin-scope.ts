import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityType } from '@archivist/shared';

/** An entry created inside a scope (decision, open item, event, note). */
export interface CreatedEntry {
  id: string;
  type: EntityType;
}

const storage = new AsyncLocalStorage<CreatedEntry[]>();

/**
 * Collects the entries created while `fn` runs – e.g. everything one chat message created, so these entries can be linked
 * with each other (#272). The list is filled even when `fn` fails: what was created before the error still belongs together.
 */
export async function collectCreated<T>(fn: () => Promise<T>, into: CreatedEntry[]): Promise<T> {
  return storage.run(into, fn);
}

/** Called by the services that create entries (via `EventBus.created`). */
export function noteCreated(entry: CreatedEntry): void {
  storage.getStore()?.push(entry);
}
