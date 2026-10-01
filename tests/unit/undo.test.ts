import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../packages/core/src/context';
import type { AuditService } from '../../packages/core/src/services/audit';
import { UndoService, type UndoHandler } from '../../packages/core/src/services/undo';
import { AppError } from '../../packages/core/src/util/errors';

interface Row {
  action: string;
  undoType: string | null;
  undoData: unknown;
  undoneAt: string | null;
  entityIds: string[];
  paths: string[];
  before: unknown;
  after: unknown;
}

const row = (overrides: Partial<Row> = {}): Row => ({
  action: 'archive.move',
  undoType: 'archive.move',
  undoData: { from: 'a', to: 'b' },
  undoneAt: null,
  entityIds: ['doc-1'],
  paths: ['/archiv/b.txt'],
  before: { path: 'a' },
  after: { path: 'b' },
  ...overrides,
});

/** UndoService mit gefälschtem Audit-Protokoll und Logger. */
function setup(auditRow: Row) {
  const audit = { getRow: vi.fn(() => auditRow), markUndone: vi.fn(), log: vi.fn() };
  const logger = { warn: vi.fn() };
  const service = new UndoService({ logger } as unknown as AppContext, audit as unknown as AuditService);
  return { service, audit, logger };
}

const handler = (overrides: Partial<UndoHandler> = {}): UndoHandler => ({
  check: async () => [],
  run: async () => 'Verschiebung rückgängig gemacht.',
  ...overrides,
});

describe('Rückgängig machen', () => {
  it('führt den Handler aus, markiert die Aktion und protokolliert die Umkehrung mit vertauschtem Vorher/Nachher', async () => {
    const { service, audit } = setup(row());
    const run = vi.fn(async () => 'fertig');
    service.register('archive.move', handler({ run }));

    const result = await service.undo('audit-1');

    expect(result).toEqual({ undone: true, message: 'fertig', conflicts: [] });
    expect(run).toHaveBeenCalledWith({ from: 'a', to: 'b' });
    expect(audit.getRow).toHaveBeenCalledWith('audit-1');
    expect(audit.markUndone).toHaveBeenCalledWith('audit-1');
    expect(audit.log).toHaveBeenCalledWith({
      action: 'undo:archive.move',
      actor: 'user',
      trigger: 'undo',
      confirmed: true,
      entityIds: ['doc-1'],
      paths: ['/archiv/b.txt'],
      before: { path: 'b' },
      after: { path: 'a' },
    });
  });

  it('lehnt Aktionen ohne Undo-Typ ab', async () => {
    const { service, audit } = setup(row({ undoType: null }));

    await expect(service.undo('x')).rejects.toMatchObject({ category: 'validation_error', message: 'Diese Aktion kann nicht rückgängig gemacht werden.' });
    expect(audit.markUndone).not.toHaveBeenCalled();
  });

  it('macht eine bereits rückgängig gemachte Aktion nicht ein zweites Mal rückgängig', async () => {
    const { service, audit } = setup(row({ undoneAt: '2026-10-01T10:00:00.000Z' }));
    const run = vi.fn(async () => 'x');
    service.register('archive.move', handler({ run }));

    expect(await service.undo('x')).toEqual({ undone: false, message: 'Die Aktion wurde bereits rückgängig gemacht.', conflicts: [] });
    expect(run).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('meldet einen fehlenden Handler mit dem Typ im Text', async () => {
    const { service } = setup(row({ undoType: 'unbekannt' }));

    await expect(service.undo('x')).rejects.toMatchObject({ category: 'validation_error', message: 'Kein Undo-Handler für „unbekannt“.' });
  });

  it('wählt den Handler passend zum Typ der Aktion', async () => {
    const { service } = setup(row({ undoType: 'b' }));
    const a = vi.fn(async () => 'a');
    const b = vi.fn(async () => 'b');
    service.register('a', handler({ run: a }));
    service.register('b', handler({ run: b }));

    expect((await service.undo('x')).message).toBe('b');
    expect(a).not.toHaveBeenCalled();
  });

  it('überschreibt bei Konflikten nichts: Handler läuft nicht, nichts wird markiert oder protokolliert, die Konflikte werden zurückgegeben', async () => {
    const { service, audit, logger } = setup(row());
    const run = vi.fn(async () => 'x');
    service.register('archive.move', handler({ check: async () => ['Ziel wurde verändert'], run }));

    const result = await service.undo('audit-7');

    expect(result).toEqual({
      undone: false,
      message: 'Rückgängig machen nicht möglich: Seit der Aktion wurde etwas verändert.',
      conflicts: ['Ziel wurde verändert'],
    });
    expect(run).not.toHaveBeenCalled();
    expect(audit.markUndone).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('undo', 'Undo wegen Konflikten abgelehnt', { auditId: 'audit-7', conflicts: ['Ziel wurde verändert'] });
  });

  it('prüft die Konflikte mit den Undo-Daten der Aktion', async () => {
    const { service } = setup(row({ undoData: { id: 42 } }));
    const check = vi.fn(async () => []);
    service.register('archive.move', handler({ check }));

    await service.undo('x');

    expect(check).toHaveBeenCalledWith({ id: 42 });
  });

  it('protokolliert einen fehlgeschlagenen Handler als Fehler, markiert nichts und reicht den Fehler weiter', async () => {
    const { service, audit } = setup(row());
    const failure = new AppError('filesystem_error', 'Datei gesperrt');
    service.register('archive.move', handler({ run: async () => Promise.reject(failure) }));

    await expect(service.undo('x')).rejects.toBe(failure);

    expect(audit.markUndone).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith({
      action: 'undo:archive.move',
      actor: 'user',
      trigger: 'undo',
      confirmed: true,
      entityIds: ['doc-1'],
      paths: ['/archiv/b.txt'],
      success: false,
      error: 'Datei gesperrt',
    });
  });

  it('protokolliert auch Fehler, die keine Error-Objekte sind', async () => {
    const { service, audit } = setup(row());
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- geprüft wird gerade ein Fehler, der kein Error-Objekt ist
    service.register('archive.move', handler({ run: async () => Promise.reject('kaputt') }));

    await expect(service.undo('x')).rejects.toBe('kaputt');

    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'kaputt' }));
  });
});
