import type { AppContext } from '../context';
import { AppError } from '../util/errors';
import type { AuditService } from './audit';

export interface UndoHandler {
  /** Returns conflicts (target objects/files changed since the action). Empty = undo is safe. */
  check(data: unknown): Promise<string[]>;
  run(data: unknown): Promise<string>;
}

/**
 * Undo foundation: handlers register per action type. Before undoing, it is checked
 * whether newer changes exist – they are never overwritten unnoticed.
 */
/** Undo of one action made of several parts (e.g. a bulk assignment, #291): its steps, undone in reverse order. */
export const COMPOSITE_UNDO_TYPE = 'composite';
export interface CompositeUndoData {
  steps: Array<{ type: string; data: unknown }>;
}

export class UndoService {
  private readonly handlers = new Map<string, UndoHandler>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.register(COMPOSITE_UNDO_TYPE, {
      check: async (data) => {
        const out: string[] = [];
        for (const s of (data as CompositeUndoData).steps) out.push(...(await this.handler(s.type).check(s.data)));
        return out;
      },
      run: async (data) => {
        const messages: string[] = [];
        for (const s of (data as CompositeUndoData).steps.toReversed()) messages.push(await this.handler(s.type).run(s.data));
        return messages.join(' ');
      },
    });
  }

  private handler(type: string): UndoHandler {
    const h = this.handlers.get(type);
    if (!h) throw new AppError('validation_error', `Kein Undo-Handler für „${type}“.`);
    return h;
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
