import type { AppContext } from '../context';
import { AppError } from '../util/errors';
import type { AuditService } from './audit';

export interface UndoHandler {
  /** Returns conflicts (target objects/files changed since the action). Empty = undo is safe. */
  check(data: unknown): Promise<string[]>;
  run(data: unknown): Promise<string>;
}

/** Undo of one action made of several parts (e.g. a bulk assignment, #291): its steps, undone in reverse order. */
export const COMPOSITE_UNDO_TYPE = 'composite';
export interface CompositeUndoData {
  steps: Array<{ type: string; data: unknown }>;
}

/** Undo foundation: handlers register per action type; newer changes are never overwritten unnoticed. */
export class UndoService {
  private readonly handlers = new Map<string, UndoHandler>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.register(COMPOSITE_UNDO_TYPE, {
      check: async (data) => {
        const conflicts: string[] = [];
        for (const step of (data as CompositeUndoData).steps) conflicts.push(...(await this.handler(step.type).check(step.data)));
        return conflicts;
      },
      run: async (data) => {
        const messages: string[] = [];
        for (const step of (data as CompositeUndoData).steps.toReversed()) messages.push(await this.handler(step.type).run(step.data));
        return messages.join(' ');
      },
    });
  }

  private handler(type: string): UndoHandler {
    const found = this.handlers.get(type);
    if (!found) throw new AppError('validation_error', `Kein Undo-Handler für „${type}“.`);
    return found;
  }

  register(type: string, handler: UndoHandler): void {
    this.handlers.set(type, handler);
  }

  async undo(auditId: string): Promise<{ undone: boolean; message: string; conflicts: string[] }> {
    const row = this.audit.getRow(auditId);
    if (!row.undoType) throw new AppError('validation_error', 'Diese Aktion kann nicht rückgängig gemacht werden.');
    if (row.undoneAt) return { undone: false, message: 'Die Aktion wurde bereits rückgängig gemacht.', conflicts: [] };
    const handler = this.handlers.get(row.undoType);
    if (!handler) throw new AppError('validation_error', `Kein Undo-Handler für „${row.undoType}“.`);
    const conflicts = await handler.check(row.undoData);
    if (conflicts.length > 0) {
      this.ctx.logger.warn('undo', 'Undo rejected because of conflicts', { auditId, conflicts });
      return { undone: false, message: 'Rückgängig machen nicht möglich: Seit der Aktion wurde etwas verändert.', conflicts };
    }
    try {
      const message = await handler.run(row.undoData);
      this.audit.markUndone(auditId);
      this.audit.log({
        action: `undo:${row.action}`,
        actor: 'user',
        trigger: 'undo',
        confirmed: true,
        entityIds: row.entityIds,
        paths: row.paths,
        before: row.after,
        after: row.before,
      });
      return { undone: true, message, conflicts: [] };
    } catch (err) {
      this.audit.log({
        action: `undo:${row.action}`,
        actor: 'user',
        trigger: 'undo',
        confirmed: true,
        entityIds: row.entityIds,
        paths: row.paths,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
