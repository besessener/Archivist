import type { AgentMode, AgentRun, AgentRunStatus, AgentStep, AgentUsage, AgentUsageSummary } from '@archivist/shared';
import { and, desc, eq, gte, isNull, like } from 'drizzle-orm';
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

/** Shortened step for storage: results stay short, arguments are kept for the technical details. */
const storedStep = (s: AgentStep): AgentStep => ({ ...s, result: s.result.slice(0, 600) });

/**
 * Agent runs (#299): every run has a run id; stored are trigger, provider and model, the tool calls with shortened results,
 * tokens and cost, duration and outcome. Every change of the run carries the run id (audit log, relations), so that the whole
 * run – or a single step – can be undone in reverse order, with the conflict check of the existing undo.
 */
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

  finish(id: string, f: RunFinish): AgentRun {
    this.db
      .update(agentRuns)
      .set({
        status: f.status,
        summary: f.summary.slice(0, 4000),
        steps: f.steps.map(storedStep) as unknown as ArchivistJson,
        usage: f.usage,
        costUsd: f.costUsd,
        rounds: f.rounds,
        applied: f.applied,
        files: f.files,
        error: f.error,
        finishedAt: nowIso(),
      })
      .where(eq(agentRuns.id, id))
      .run();
    this.ctx.events.changed('agent', 'audit');
    return this.get(id);
  }

  /** Steps executed later from a confirmed proposal card of the run (they carry the run id, so undo covers them). */
  appendSteps(id: string, steps: AgentStep[]): void {
    const r = this.db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    if (!r) return;
    const all = [...((r.steps as unknown as AgentStep[]) ?? []), ...steps.map(storedStep)];
    this.db
      .update(agentRuns)
      .set({ steps: all as unknown as ArchivistJson })
      .where(eq(agentRuns.id, id))
      .run();
    this.ctx.events.changed('agent');
  }

  /** Runs still marked as running from before a restart are closed as cancelled; what they did stays logged. */
  closeInterrupted(): number {
    const res = this.db
      .update(agentRuns)
      .set({ status: 'cancelled', error: 'Durch einen Neustart unterbrochen.', finishedAt: nowIso() })
      .where(eq(agentRuns.status, 'running'))
      .run();
    return res.changes;
  }

  private undoableCount(runId: string): number {
    return this.audit.forRun(runId).filter((r) => r.undoType && !r.undoneAt && r.success).length;
  }

  private map(r: Row): AgentRun {
    return {
      id: r.id,
      conversationId: r.conversationId,
      trigger: r.trigger,
      task: r.task,
      provider: r.provider,
      model: r.model,
      mode: r.mode as AgentMode,
      status: r.status as AgentRunStatus,
      summary: r.summary,
      steps: (r.steps as unknown as AgentStep[]) ?? [],
      usage: { ...emptyUsage(), ...(r.usage as unknown as Partial<AgentUsage>) },
      costUsd: r.costUsd,
      rounds: r.rounds,
      applied: (r.applied as unknown as AgentRun['applied']) ?? [],
      files: r.files,
      undoable: this.undoableCount(r.id),
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    };
  }

  get(id: string): AgentRun {
    const r = this.db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Agentenlauf nicht gefunden.');
    return this.map(r);
  }

  list(opts: { trigger?: 'chat' | 'background'; status?: AgentRunStatus; conversationId?: string; limit?: number } = {}): AgentRun[] {
    const conds = [
      opts.trigger === 'chat' ? eq(agentRuns.trigger, 'chat') : opts.trigger === 'background' ? like(agentRuns.trigger, 'background:%') : undefined,
      opts.status ? eq(agentRuns.status, opts.status) : undefined,
      opts.conversationId ? eq(agentRuns.conversationId, opts.conversationId) : undefined,
    ].filter(Boolean);
    return this.db
      .select()
      .from(agentRuns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(agentRuns.startedAt))
      .limit(opts.limit ?? 100)
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
        const r = await this.undo.undo(id);
        if (r.undone) undone += 1;
        else if (r.conflicts.length) {
          failed += 1;
          conflicts.push(...r.conflicts);
        }
      } catch (err) {
        failed += 1;
        conflicts.push(toErrorInfo(err).message);
      }
    }
    const message =
      undone && !failed
        ? `${undone} Änderung(en) rückgängig gemacht.`
        : undone
          ? `${undone} Änderung(en) rückgängig gemacht, ${failed} nicht möglich.`
          : failed
            ? 'Nichts rückgängig gemacht: Seit dem Lauf wurde etwas verändert.'
            : 'Es gab nichts rückgängig zu machen.';
    this.ctx.events.changed('agent');
    return { undone, failed, conflicts: [...new Set(conflicts)], message };
  }

  /** „Lauf rückgängig“: all changes of the run in reverse order. */
  async undoRun(runId: string): Promise<UndoRunResult> {
    this.get(runId);
    const rows = this.audit.forRun(runId).filter((r) => r.undoType && !r.undoneAt && r.success);
    return this.undoEntries(rows.map((r) => r.id));
  }

  /** Undoes a single step of a run (its audit entries, newest first). */
  async undoStep(runId: string, stepId: string): Promise<UndoRunResult> {
    const run = this.get(runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new AppError('validation_error', 'Schritt nicht gefunden.');
    const rows = this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.runId, runId), isNull(auditLog.undoneAt)))
      .all();
    const wanted = new Set(step.auditIds);
    const ids = rows
      .filter((r) => wanted.has(r.id) && r.undoType && r.success)
      .toSorted((a, b) => b.at.localeCompare(a.at))
      .map((r) => r.id);
    return this.undoEntries(ids);
  }

  /** Usage per day and month, by chat and background (#302). */
  usageSummary(days = 31): AgentUsageSummary {
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const rows = this.db.select().from(agentRuns).where(gte(agentRuns.startedAt, since)).all();
    const dayLimit = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const dayMap = new Map<string, AgentUsageSummary['days'][number]>();
    const monthMap = new Map<string, AgentUsageSummary['months'][number]>();
    const total = { runs: 0, tokens: 0, costUsd: 0 };
    for (const r of rows) {
      const trigger = r.trigger === 'chat' ? 'chat' : 'background';
      const usage = { ...emptyUsage(), ...(r.usage as unknown as Partial<AgentUsage>) };
      const tokens = budgetTokens(usage);
      const cost = r.costUsd ?? 0;
      const day = r.startedAt.slice(0, 10);
      const month = r.startedAt.slice(0, 7);
      if (day >= dayLimit) {
        const d = dayMap.get(`${day}|${trigger}`) ?? { day, trigger, runs: 0, tokens: 0, costUsd: 0 };
        dayMap.set(`${day}|${trigger}`, { ...d, runs: d.runs + 1, tokens: d.tokens + tokens, costUsd: d.costUsd + cost });
      }
      const m = monthMap.get(`${month}|${trigger}`) ?? { month, trigger, runs: 0, tokens: 0, costUsd: 0 };
      monthMap.set(`${month}|${trigger}`, { ...m, runs: m.runs + 1, tokens: m.tokens + tokens, costUsd: m.costUsd + cost });
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
