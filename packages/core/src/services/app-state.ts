import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { appState } from '../db/schema';
import { nowIso } from '../util/ids';
import type { LastRunStore } from './scheduler';

/** Small persistent key-value store for application state that must survive restarts. */
export class AppStateService {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  get(key: string): string | null {
    return this.db.select().from(appState).where(eq(appState.key, key)).get()?.value ?? null;
  }

  set(key: string, value: string): void {
    const updatedAt = nowIso();
    this.db.insert(appState).values({ key, value, updatedAt }).onConflictDoUpdate({ target: appState.key, set: { value, updatedAt } }).run();
  }

  /** Keeps the last run of a schedule (ISO timestamp under `key`), so its rhythm continues after a restart. */
  lastRunStore(key: string): LastRunStore {
    return {
      get: () => {
        const at = Date.parse(this.get(key) ?? '');
        return Number.isFinite(at) ? at : null;
      },
      set: (at) => this.set(key, new Date(at).toISOString()),
    };
  }
}
