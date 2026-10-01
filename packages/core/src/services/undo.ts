import type { AppContext } from '../context';
import { AppError } from '../util/errors';
import type { AuditService } from './audit';

export interface UndoHandler {
  /** Liefert Konflikte (Zielobjekte/Dateien seit der Aktion verändert). Leer = Undo ist sicher. */
  check(data: unknown): Promise<string[]>;
  run(data: unknown): Promise<string>;
}

/**
 * Undo-Grundlage: Handler registrieren sich pro Aktionstyp. Vor dem Rückgängigmachen wird geprüft,
 * ob neuere Änderungen existieren – diese werden nie unbemerkt überschrieben.
 */
export class UndoService {
  private readonly handlers = new Map<string, UndoHandler>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {}

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
      this.ctx.logger.warn('undo', 'Undo wegen Konflikten abgelehnt', { auditId, conflicts });
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
