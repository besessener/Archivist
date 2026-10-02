import type { AppContext } from '../../context';
import { sha256Text } from '../../util/hash';
import type { ContradictionService } from '../contradictions';
import type { DecisionService } from '../decisions';
import type { InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NotificationService } from '../notifications';
import type { OpenItemService } from '../open-items';
import type { SettingsService } from '../settings';

/** The services the archive check reads from and reports to. */
export interface CheckDeps {
  ctx: AppContext;
  settings: SettingsService;
  decisions: DecisionService;
  openItems: OpenItemService;
  graph: KnowledgeGraphService;
  contradictions: ContradictionService;
  insights: InsightService;
  notifications: NotificationService;
}

/** What one run of the archive check found; hints whose key is missing afterwards are closed. */
export class Findings {
  /** Dedupe keys of the insights whose cause still exists. */
  readonly insightKeys = new Set<string>();
  /** Dedupe keys of the notifications whose cause still exists. */
  readonly notificationKeys = new Set<string>();
  readonly byKind: Record<string, number> = {};
  /** Notifications created by this run. */
  notifications = 0;

  readonly count = (kind: string, n = 1): void => {
    this.byKind[kind] = (this.byKind[kind] ?? 0) + n;
  };
}

/** One run of the archive check: the services, what it found so far and its cancellation. */
export interface CheckRun {
  deps: CheckDeps;
  findings: Findings;
  signal?: AbortSignal;
}

/** Lets pending I/O and IPC callbacks run before the next synchronous section. */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Long loops of a step hand the main thread back to pending IPC calls every this many items (#215). */
const YIELD_EVERY = 250;

/** Yields to the event loop at every {@link YIELD_EVERY}th item of a long loop. */
export async function yieldPeriodically(index: number): Promise<void> {
  if (index > 0 && index % YIELD_EVERY === 0) await yieldToEventLoop();
}

/** A short stable hash of a set of ids, for the dedupe key of an aggregated hint. */
export const idsHash = (ids: string[]): string => sha256Text([...ids].sort().join('|')).slice(0, 12);
