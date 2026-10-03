import type { AuditEntry, AuditVerification } from '@archivist/shared';
import { and, asc, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog, entities } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import { AppError } from '../util/errors';
import { currentRun } from '../agent/scope';
import { chainHash, verifyChain } from './audit-chain';

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
    const fixed = {
      id,
      at: nowIso(),
      action: input.action,
      actor: run ? 'agent' : input.actor,
      trigger: input.trigger,
      confirmed: input.confirmed,
      entityIds: input.entityIds ?? [],
      paths: input.paths ?? [],
      before: (input.before ?? null) as ArchivistJson | null,
      success: input.success ?? true,
      runId: run?.runId ?? null,
    };
    const prevHash = this.newestHash();
    this.ctx.database.db
      .insert(auditLog)
      .values({
        ...fixed,
        after: (input.after ?? null) as ArchivistJson | null,
        error: input.error ?? null,
        undoType: undo?.type ?? null,
        undoData: (undo?.data ?? null) as ArchivistJson | null,
        prevHash,
        hash: chainHash(fixed, prevHash),
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

  private newestHash(): string | null {
    return (
      this.ctx.database.db
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .orderBy(sql`rowid desc`)
        .limit(1)
        .get()?.hash ?? null
    );
  }

  /** Checks the hash chain: no entry was changed, removed or inserted since it was written (entries from before the chain are not covered). */
  verify(): AuditVerification {
    return verifyChain(
      this.ctx.database.db
        .select()
        .from(auditLog)
        .orderBy(asc(sql`rowid`))
        .all(),
    );
  }

  /** Titles of the entries the rows concern: the graph node's name, else the title the entry itself recorded (e.g. of a deleted one). */
  private titlesOf(rows: Row[]): Map<string, string> {
    const ids = [...new Set(rows.flatMap((row) => row.entityIds))];
    const named = new Map<string, string>();
    for (let start = 0; start < ids.length; start += 500)
      for (const { id, name } of this.ctx.database.db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(inArray(entities.id, ids.slice(start, start + 500)))
        .all())
        named.set(id, name);
    for (const row of rows) {
      const first = row.entityIds[0];
      const recorded = [row.before, row.after].map((value) => (value as { title?: unknown } | null)?.title).find((title) => typeof title === 'string');
      if (first && !named.has(first) && typeof recorded === 'string') named.set(first, recorded);
    }
    return named;
  }

  private toEntry(r: Row, titles: Map<string, string>): AuditEntry {
    return {
      id: r.id,
      at: r.at,
      action: r.action,
      actor: r.actor === 'agent' ? 'agent' : 'user',
      trigger: r.trigger,
      confirmed: r.confirmed,
      entityIds: r.entityIds,
      entities: r.entityIds.flatMap((id) => (titles.has(id) ? [{ id, title: titles.get(id)! }] : [])),
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

  list({ limit = 200, onlyUndoable = false, entityId }: { limit?: number; onlyUndoable?: boolean; entityId?: string } = {}): AuditEntry[] {
    const rows = this.ctx.database.db
      .select()
      .from(auditLog)
      .where(entityId ? sql`EXISTS (SELECT 1 FROM json_each(${auditLog.entityIds}) WHERE value = ${entityId})` : undefined)
      .orderBy(desc(auditLog.at), sql`rowid desc`)
      .limit(limit * (onlyUndoable ? 5 : 1))
      .all();
    const titles = this.titlesOf(rows);
    const entries = rows.map((r) => this.toEntry(r, titles));
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

  /** Corrects what an entry recorded once the outcome is known (written before the files were touched). */
  amend(id: string, patch: { after: unknown; undo: { type: string; data: unknown } }): void {
    this.ctx.database.db
      .update(auditLog)
      .set({ after: patch.after as ArchivistJson, undoType: patch.undo.type, undoData: patch.undo.data as ArchivistJson })
      .where(eq(auditLog.id, id))
      .run();
    this.ctx.events.changed('audit');
  }

  markUndone(id: string): void {
    this.ctx.database.db.update(auditLog).set({ undoneAt: nowIso() }).where(eq(auditLog.id, id)).run();
    this.ctx.events.changed('audit');
  }
}
