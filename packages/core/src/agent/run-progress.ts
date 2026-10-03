import type { AgentProgress } from '@archivist/shared';
import type { EventBus } from '../context';

/** Throttle of the live view while text streams in. */
const EMIT_DELAY_MS = 120;

const keyOf = (progress: AgentProgress) => progress.conversationId ?? progress.runId;

/** Live state of the running runs (#300) and their „Stopp“ (#295). */
export class RunProgress {
  /** By conversation, or by run for background runs. */
  private readonly active = new Map<string, AgentProgress>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly emitTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly events: EventBus) {}

  track(runId: string, controller: AbortController): void {
    this.controllers.set(runId, controller);
  }

  show(progress: AgentProgress): void {
    this.active.set(keyOf(progress), progress);
    this.emitNow(progress);
  }

  end(progress: AgentProgress): void {
    this.controllers.delete(progress.runId);
    this.active.delete(keyOf(progress));
  }

  emitNow(progress: AgentProgress): void {
    clearTimeout(this.emitTimers.get(progress.runId));
    this.emitTimers.delete(progress.runId);
    this.events.emit('agent:progress', progress);
  }

  emitSoon(progress: AgentProgress): void {
    if (this.emitTimers.has(progress.runId)) return;
    this.emitTimers.set(
      progress.runId,
      setTimeout(() => {
        this.emitTimers.delete(progress.runId);
        this.events.emit('agent:progress', this.active.get(keyOf(progress)) ?? progress);
      }, EMIT_DELAY_MS),
    );
  }

  /** Live state of the running run of a conversation (after switching tabs or reloading the UI, #300). */
  progressFor(conversationId: string): AgentProgress | null {
    return this.active.get(conversationId) ?? null;
  }

  activeRuns(): AgentProgress[] {
    return [...this.active.values()];
  }

  /** Stops the running run of a conversation (or all); what is done stays (#295). */
  cancel(conversationId?: string): number {
    let cancelled = 0;
    for (const progress of this.active.values()) {
      if (conversationId && progress.conversationId !== conversationId) continue;
      if (this.cancelRun(progress.runId)) cancelled += 1;
    }
    return cancelled;
  }

  cancelRun(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  abortAll(reason: Error): void {
    for (const controller of this.controllers.values()) controller.abort(reason);
  }
}
