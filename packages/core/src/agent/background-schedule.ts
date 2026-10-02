import { localToday } from '@archivist/shared';
import type { AppContext } from '../context';
import type { AppStateService } from '../services/app-state';
import type { LlmService } from '../services/llm';
import type { BackgroundKind } from './background-tasks';
import type { MemoryService } from './memory';
import type { AgentRunService } from './runs';
import type { ToolDeps } from './tools/common';
import { DeadlineWatcher, type PostToConversation } from './watcher';

const TICK_INTERVAL_MS = 10 * 60_000;
const FIRST_TICK_MS = 30_000;
/** Inbox documents remembered as seen; older ones drop out. */
const MAX_SEEN_INBOX = 5000;

export type EnqueueBackground = (kind: BackgroundKind, docIds: string[]) => void;

interface ScheduleDeps {
  ctx: AppContext;
  tools: ToolDeps;
  appState: AppStateService;
  runs: AgentRunService;
  memory: MemoryService;
  llm: LlmService;
  isActive: () => boolean;
}

/** Timers of the background work (#313, #314): deadline watcher, weekly review, nightly runs and the inbox run. */
export class BackgroundSchedule {
  private timer: NodeJS.Timeout | null = null;
  private inboxTimer: NodeJS.Timeout | null = null;
  private watcher: DeadlineWatcher | null = null;
  /** Puts a background run into the job queue; does nothing until `start`. */
  private enqueue: EnqueueBackground = () => undefined;

  constructor(private readonly deps: ScheduleDeps) {}

  private get background() {
    return this.deps.tools.settings.get().agent.background;
  }

  start(options: { enqueue: EnqueueBackground; post: PostToConversation }): void {
    this.enqueue = options.enqueue;
    this.watcher = new DeadlineWatcher({
      settings: this.deps.tools.settings,
      appState: this.deps.appState,
      notifications: this.deps.tools.notifications,
      runs: this.deps.runs,
      tools: this.deps.tools,
      post: options.post,
    });
    this.deps.runs.closeInterrupted();
    this.timer ??= setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => this.tick(), FIRST_TICK_MS).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.timer = null;
    this.inboxTimer = null;
  }

  /** Periodic check: deadline watcher, weekly review, nightly background runs. */
  tick(now = new Date()): void {
    try {
      this.watcher?.checkDeadlines(now);
      this.watcher?.weeklyReview(now);
      if (this.nightlyDue(now)) this.enqueueNightly(now);
    } catch (err) {
      this.deps.ctx.logger.warn('agent', 'Background tick failed', { error: err });
    }
  }

  private nightlyDue(now: Date): boolean {
    const { nightlyHour } = this.background;
    return (
      nightlyHour !== null && now.getHours() === nightlyHour && this.deps.appState.get('agent.nightly.lastDay') !== localToday(now) && this.deps.isActive()
    );
  }

  private enqueueNightly(now: Date): void {
    const background = this.background;
    this.deps.appState.set('agent.nightly.lastDay', localToday(now));
    if (background.archiveCheck) this.enqueue('archive_check', []);
    if (background.links) this.enqueue('links', []);
    const weekday = now.getDay();
    for (const workflow of this.deps.memory.list('workflow'))
      if (workflow.enabled && (workflow.data as { scheduleWeekday?: number | null } | null)?.scheduleWeekday === weekday)
        this.enqueue(`workflow:${workflow.id}`, []);
  }

  /** New files were analyzed: a little later ONE inbox run sorts all of them (#313). */
  scheduleInbox(delayMs = 20_000): void {
    if (!this.background.inbox || !this.deps.isActive() || !this.deps.llm.canUseInBackground()) return;
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = null;
      const ids = this.inboxCandidates();
      if (ids.length) this.enqueue('inbox', ids);
    }, delayMs);
    this.inboxTimer.unref?.();
  }

  /** Analyzed inbox documents the background agent has not looked at yet (nothing is paid for twice after a restart). */
  inboxCandidates(): string[] {
    const seen = new Set<string>(this.seenInbox());
    return this.deps.tools.docs
      .list({ statuses: ['proposed'], limit: 500 })
      .filter((d) => !seen.has(d.id))
      .map((d) => d.id);
  }

  markInboxSeen(ids: string[]): void {
    this.deps.appState.set('agent.inbox.seen', JSON.stringify([...new Set([...this.seenInbox(), ...ids])].slice(-MAX_SEEN_INBOX)));
  }

  private seenInbox(): string[] {
    try {
      return JSON.parse(this.deps.appState.get('agent.inbox.seen') ?? '[]') as string[];
    } catch {
      return [];
    }
  }
}
