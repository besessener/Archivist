import type { AuditEntry } from '@archivist/shared';
import { and, desc, eq, isNotNull, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import { AppError } from '../util/errors';
import { currentRun } from '../agent/scope';

export interface AuditInput {
  action: string;
  actor: 'user' | 'agent';
  trigger: string;
  confirmed: boolean;
  entityIds?: string[];
  paths?: string[];
  before?: unknown;
  after?: unknown;
  success?: boolean;
  error?: string | null;
  undo?: { type: string; data: unknown };
}

type Row = typeof auditLog.$inferSelect;

/** What listeners get after an entry was written (e.g. the agent notices corrections of its own work, #315). */
export type AuditListener = (entry: AuditInput & { id: string; runId: string | null }) => void;

export class AuditService {
  private readonly listeners: AuditListener[] = [];

  constructor(private readonly ctx: AppContext) {}

  onLog(listener: AuditListener): void {
    this.listeners.push(listener);
  }

  /** Newest successful change of an entity made inside an agent run whose action starts with `prefix`. */
  lastAgentChange(entityId: string, prefix: string): Row | undefined {
    return this.ctx.database.db
      .select()
      .from(auditLog)
      .where(
        and(
          like(auditLog.action, `${prefix}%`),
          isNotNull(auditLog.runId),
          sql`EXISTS (SELECT 1 FROM json_each(${auditLog.entityIds}) WHERE value = ${entityId})`,
        ),
      )
      .orderBy(desc(auditLog.at))
      .limit(1)
      .get();
  }

  log(input: AuditInput): string {
    const id = newId();
    // inside an agent run every change carries the run id and counts as the agent's change (#299)
    const run = currentRun();
    if (run && input.success !== false) run.auditIds.push(id);
    // entries the agent creates can be taken back with the run, also where the service itself offers no undo
    const undo =
      input.undo ??
      (run && input.success !== false && /\.create$/.test(input.action) && input.entityIds?.[0]
        ? { type: 'agent_created', data: { action: input.action, id: input.entityIds[0] } }
        : undefined);
    this.ctx.database.db
      .insert(auditLog)
      .values({
        id,
        at: nowIso(),
        action: input.action,
        actor: run ? 'agent' : input.actor,
        trigger: input.trigger,
        confirmed: input.confirmed,
        entityIds: input.entityIds ?? [],
        paths: input.paths ?? [],
        before: (input.before ?? null) as ArchivistJson | null,
        after: (input.after ?? null) as ArchivistJson | null,
        success: input.success ?? true,
        error: input.error ?? null,
        undoType: undo?.type ?? null,
        undoData: (undo?.data ?? null) as ArchivistJson | null,
        runId: run?.runId ?? null,
      })
      .run();
    this.ctx.events.changed('audit');
    for (const listener of this.listeners) {
      try {
        listener({ ...input, id, runId: run?.runId ?? null });
      } catch (err) {
        this.ctx.logger.warn('audit', 'Audit listener failed', { error: err });
      }
    }
    return id;
  }

  private toEntry(r: Row): AuditEntry {
    return {
      id: r.id,
      at: r.at,
      action: r.action,
      actor: r.actor === 'agent' ? 'agent' : 'user',
      trigger: r.trigger,
      confirmed: r.confirmed,
      entityIds: r.entityIds,
      paths: r.paths,
      before: r.before,
      after: r.after,
      success: r.success,
      error: r.error,
      undoable: Boolean(r.undoType) && !r.undoneAt && r.success,
      undoneAt: r.undoneAt,
      runId: r.runId,
    };
  }

  list(limit = 200, onlyUndoable = false): AuditEntry[] {
    const rows = this.ctx.database.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.at))
      .limit(limit * (onlyUndoable ? 5 : 1))
      .all();
    const entries = rows.map((r) => this.toEntry(r));
    return (onlyUndoable ? entries.filter((e) => e.undoable) : entries).slice(0, limit);
  }

  /** Changes of one agent run, newest first (undo of a whole run goes through them in this order). */
  forRun(runId: string): Row[] {
    return this.ctx.database.db.select().from(auditLog).where(eq(auditLog.runId, runId)).orderBy(desc(auditLog.at)).all();
  }

  getRow(id: string): Row {
    const row = this.ctx.database.db.select().from(auditLog).where(eq(auditLog.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Audit-Eintrag nicht gefunden.');
    return row;
  }

  /** Ends the undo of an entry whose undo data no longer exists (e.g. files deleted from the trash); the entry itself stays. */
  endUndo(id: string): void {
    this.ctx.database.db.update(auditLog).set({ undoType: null, undoData: null }).where(eq(auditLog.id, id)).run();
    this.ctx.events.changed('audit');
  }

  markUndone(id: string): void {
    this.ctx.database.db.update(auditLog).set({ undoneAt: nowIso() }).where(eq(auditLog.id, id)).run();
    this.ctx.events.changed('audit');
  }
}
