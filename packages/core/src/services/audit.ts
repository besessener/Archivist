import type { AuditEntry } from '@archivist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import { AppError } from '../util/errors';

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

export class AuditService {
  constructor(private readonly ctx: AppContext) {}

  log(input: AuditInput): string {
    const id = newId();
    this.ctx.database.db
      .insert(auditLog)
      .values({
        id,
        at: nowIso(),
        action: input.action,
        actor: input.actor,
        trigger: input.trigger,
        confirmed: input.confirmed,
        entityIds: input.entityIds ?? [],
        paths: input.paths ?? [],
        before: (input.before ?? null) as ArchivistJson | null,
        after: (input.after ?? null) as ArchivistJson | null,
        success: input.success ?? true,
        error: input.error ?? null,
        undoType: input.undo?.type ?? null,
        undoData: (input.undo?.data ?? null) as ArchivistJson | null,
      })
      .run();
    this.ctx.events.changed('audit');
    return id;
  }

  private map(r: Row): AuditEntry {
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
    };
  }

  list(limit = 200, onlyUndoable = false): AuditEntry[] {
    const rows = this.ctx.database.db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(limit * (onlyUndoable ? 5 : 1)).all();
    const mapped = rows.map((r) => this.map(r));
    return (onlyUndoable ? mapped.filter((m) => m.undoable) : mapped).slice(0, limit);
  }

  getRow(id: string): Row {
    const row = this.ctx.database.db.select().from(auditLog).where(eq(auditLog.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Audit-Eintrag nicht gefunden.');
    return row;
  }

  markUndone(id: string): void {
    this.ctx.database.db.update(auditLog).set({ undoneAt: nowIso() }).where(eq(auditLog.id, id)).run();
    this.ctx.events.changed('audit');
  }
}
