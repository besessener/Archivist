import type { AgentMode, AgentRun, AgentRunStatus, AgentStep, AgentUsage, AgentUsageSummary } from '@archivist/shared';
import { and, desc, eq, gte, isNull, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentRuns, auditLog } from '../db/schema';
import { AppError, toErrorInfo } from '../util/errors';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import type { AuditService } from '../services/audit';
import type { UndoService } from '../services/undo';
import { budgetTokens, emptyUsage } from './pricing';

type Row = typeof agentRuns.$inferSelect;

export interface RunStart {
  conversationId: string | null;
  trigger: string;
  task: string;
  provider: string;
  model: string;
  mode: AgentMode;
}

export interface RunFinish {
  status: AgentRunStatus;
  summary: string;
  steps: AgentStep[];
  usage: AgentUsage;
  costUsd: number | null;
  rounds: number;
  applied: AgentRun['applied'];
  files: string[];
  error: string | null;
}

export interface UndoRunResult {
  undone: number;
  failed: number;
  conflicts: string[];
  message: string;
}

function undoMessage(undone: number, failed: number): string {
  if (undone && !failed) return `${undone} Änderung(en) rückgängig gemacht.`;
  if (undone) return `${undone} Änderung(en) rückgängig gemacht, ${failed} nicht möglich.`;
  return failed ? 'Nichts rückgängig gemacht: Seit dem Lauf wurde etwas verändert.' : 'Es gab nichts rückgängig zu machen.';
}

function triggerCondition(trigger: 'chat' | 'background' | undefined) {
  if (trigger === 'chat') return eq(agentRuns.trigger, 'chat');
  return trigger === 'background' ? like(agentRuns.trigger, 'background:%') : undefined;
}

/** Shortened step for storage: results stay short, arguments are kept for the technical details. */
const storedStep = (s: AgentStep): AgentStep => ({ ...s, result: s.result.slice(0, 600) });

/** Agent runs (#299): log of each run, whose changes carry its id so the run or a single step can be undone in reverse order. */
export class AgentRunService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly undo: UndoService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  start(input: RunStart): string {
    const id = newId();
    this.db
      .insert(agentRuns)
      .values({ id, ...input, status: 'running', summary: '', steps: [], usage: emptyUsage(), rounds: 0, startedAt: nowIso() })
      .run();
    this.ctx.events.changed('agent');
    return id;
  }

  /** Intermediate state, so that a run interrupted by a restart is still visible with what it did. */
  checkpoint(id: string, steps: AgentStep[], usage: AgentUsage): void {
    this.db
      .update(agentRuns)
      .set({ steps: steps.map(storedStep) as unknown as ArchivistJson, usage: usage })
      .where(eq(agentRuns.id, id))
      .run();
  }

  finish(id: string, finished: RunFinish): AgentRun {
    this.db
      .update(agentRuns)
      .set({
        status: finished.status,
        summary: finished.summary.slice(0, 4000),
        steps: finished.steps.map(storedStep) as unknown as ArchivistJson,
        usage: finished.usage,
        costUsd: finished.costUsd,
        rounds: finished.rounds,
        applied: finished.applied,
        files: finished.files,
        error: finished.error,
        finishedAt: nowIso(),
      })
      .where(eq(agentRuns.id, id))
      .run();
    this.ctx.events.changed('agent', 'audit');
    return this.get(id);
  }

  /** Steps executed later from a confirmed proposal card of the run (they carry the run id, so undo covers them). */
  appendSteps(id: string, steps: AgentStep[]): void {
    const row = this.db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    if (!row) return;
    const all = [...((row.steps as unknown as AgentStep[]) ?? []), ...steps.map(storedStep)];
    this.db
      .update(agentRuns)
      .set({ steps: all as unknown as ArchivistJson })
      .where(eq(agentRuns.id, id))
      .run();
    this.ctx.events.changed('agent');
  }

  /** Audit entries a file job wrote for a step after its run had ended (resumed after a restart, #304), so undo per step covers them. */
  addStepAudit(id: string, stepId: string, auditIds: string[]): void {
    if (!auditIds.length) return;
    const row = this.db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    const steps = (row?.steps as unknown as AgentStep[] | undefined) ?? [];
    const step = steps.find((s) => s.id === stepId);
    if (!step) return;
    step.auditIds = [...new Set([...step.auditIds, ...auditIds])];
    this.db
      .update(agentRuns)
      .set({ steps: steps as unknown as ArchivistJson })
      .where(eq(agentRuns.id, id))
      .run();
    this.ctx.events.changed('agent');
  }

  /** Runs still marked as running from before a restart are closed as cancelled; what they did stays logged. */
  closeInterrupted(): number {
    const closed = this.db
      .update(agentRuns)
      .set({ status: 'cancelled', error: 'Durch einen Neustart unterbrochen.', finishedAt: nowIso() })
      .where(eq(agentRuns.status, 'running'))
      .run();
    return closed.changes;
  }

  private undoableCount(runId: string): number {
    return this.audit.forRun(runId).filter((r) => r.undoType && !r.undoneAt && r.success).length;
  }

  private map(row: Row): AgentRun {
    return {
      id: row.id,
      conversationId: row.conversationId,
      trigger: row.trigger,
      task: row.task,
      provider: row.provider,
      model: row.model,
      mode: row.mode as AgentMode,
      status: row.status as AgentRunStatus,
      summary: row.summary,
      steps: (row.steps as unknown as AgentStep[]) ?? [],
      usage: { ...emptyUsage(), ...(row.usage as unknown as Partial<AgentUsage>) },
      costUsd: row.costUsd,
      rounds: row.rounds,
      applied: (row.applied as unknown as AgentRun['applied']) ?? [],
      files: row.files,
      undoable: this.undoableCount(row.id),
      error: row.error,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  get(id: string): AgentRun {
    const row = this.db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Agentenlauf nicht gefunden.');
    return this.map(row);
  }

  list(filter: { trigger?: 'chat' | 'background'; status?: AgentRunStatus; conversationId?: string; limit?: number } = {}): AgentRun[] {
    const conditions = [
      triggerCondition(filter.trigger),
      filter.status ? eq(agentRuns.status, filter.status) : undefined,
      filter.conversationId ? eq(agentRuns.conversationId, filter.conversationId) : undefined,
    ].filter(Boolean);
    return this.db
      .select()
      .from(agentRuns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(agentRuns.startedAt))
      .limit(filter.limit ?? 100)
      .all()
      .map((r) => this.map(r));
  }

  /** Undoes the given audit entries newest first; every entry is checked for conflicts on its own. */
  private async undoEntries(ids: string[]): Promise<UndoRunResult> {
    let undone = 0;
    let failed = 0;
    const conflicts: string[] = [];
    for (const id of ids) {
      try {
        const outcome = await this.undo.undo(id);
        if (outcome.undone) undone += 1;
        else if (outcome.conflicts.length) {
          failed += 1;
          conflicts.push(...outcome.conflicts);
        }
      } catch (err) {
        failed += 1;
        conflicts.push(toErrorInfo(err).message);
      }
    }
    this.ctx.events.changed('agent');
    return { undone, failed, conflicts: [...new Set(conflicts)], message: undoMessage(undone, failed) };
  }

  /** Undoable entries of a run, newest first; rowid breaks ties of entries sharing a millisecond timestamp. */
  private undoableNewestFirst(runId: string): Array<typeof auditLog.$inferSelect> {
    return this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.runId, runId), isNull(auditLog.undoneAt)))
      .orderBy(desc(auditLog.at), sql`rowid desc`)
      .all()
      .filter((r) => r.undoType && r.success);
  }

  /** „Lauf rückgängig“: all changes of the run in reverse order. */
  async undoRun(runId: string): Promise<UndoRunResult> {
    this.get(runId);
    return this.undoEntries(this.undoableNewestFirst(runId).map((r) => r.id));
  }

  /** Undoes a single step of a run (its audit entries, newest first). */
  async undoStep(runId: string, stepId: string): Promise<UndoRunResult> {
    const run = this.get(runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new AppError('validation_error', 'Schritt nicht gefunden.');
    const wanted = new Set(step.auditIds);
    return this.undoEntries(
      this.undoableNewestFirst(runId)
        .filter((r) => wanted.has(r.id))
        .map((r) => r.id),
    );
  }

  /** Usage per day and month, by chat and background (#302). */
  usageSummary(days = 31): AgentUsageSummary {
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const rows = this.db.select().from(agentRuns).where(gte(agentRuns.startedAt, since)).all();
    const dayLimit = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const dayMap = new Map<string, AgentUsageSummary['days'][number]>();
    const monthMap = new Map<string, AgentUsageSummary['months'][number]>();
    const total = { runs: 0, tokens: 0, costUsd: 0 };
    for (const row of rows) {
      const trigger = row.trigger === 'chat' ? 'chat' : 'background';
      const usage = { ...emptyUsage(), ...(row.usage as unknown as Partial<AgentUsage>) };
      const tokens = budgetTokens(usage);
      const cost = row.costUsd ?? 0;
      const day = row.startedAt.slice(0, 10);
      const month = row.startedAt.slice(0, 7);
      if (day >= dayLimit) {
        const dayEntry = dayMap.get(`${day}|${trigger}`) ?? { day, trigger, runs: 0, tokens: 0, costUsd: 0 };
        dayMap.set(`${day}|${trigger}`, { ...dayEntry, runs: dayEntry.runs + 1, tokens: dayEntry.tokens + tokens, costUsd: dayEntry.costUsd + cost });
      }
      const monthEntry = monthMap.get(`${month}|${trigger}`) ?? { month, trigger, runs: 0, tokens: 0, costUsd: 0 };
      monthMap.set(`${month}|${trigger}`, { ...monthEntry, runs: monthEntry.runs + 1, tokens: monthEntry.tokens + tokens, costUsd: monthEntry.costUsd + cost });
      total.runs += 1;
      total.tokens += tokens;
      total.costUsd += cost;
    }
    const round = <T extends { costUsd: number }>(x: T) => ({ ...x, costUsd: Math.round(x.costUsd * 10_000) / 10_000 });
    return {
      days: [...dayMap.values()].toSorted((a, b) => b.day.localeCompare(a.day) || a.trigger.localeCompare(b.trigger)).map(round),
      months: [...monthMap.values()].toSorted((a, b) => b.month.localeCompare(a.month) || a.trigger.localeCompare(b.trigger)).map(round),
      total: round(total),
    };
  }
}
