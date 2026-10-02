import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../packages/core/src/context';
import type { AuditService } from '../../packages/core/src/services/audit';
import { COMPOSITE_UNDO_TYPE, UndoService, type UndoHandler } from '../../packages/core/src/services/undo';
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

/** UndoService with a fake audit log and logger. */
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

describe('undo', () => {
  it('runs the handler, marks the action and logs the reversal with before/after swapped', async () => {
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

  it('rejects actions without an undo type', async () => {
    const { service, audit } = setup(row({ undoType: null }));

    await expect(service.undo('x')).rejects.toMatchObject({ category: 'validation_error', message: 'Diese Aktion kann nicht rückgängig gemacht werden.' });
    expect(audit.markUndone).not.toHaveBeenCalled();
  });

  it('does not undo an already undone action a second time', async () => {
    const { service, audit } = setup(row({ undoneAt: '2026-10-01T10:00:00.000Z' }));
    const run = vi.fn(async () => 'x');
    service.register('archive.move', handler({ run }));

    expect(await service.undo('x')).toEqual({ undone: false, message: 'Die Aktion wurde bereits rückgängig gemacht.', conflicts: [] });
    expect(run).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('reports a missing handler with the type in the message', async () => {
    const { service } = setup(row({ undoType: 'unbekannt' }));

    await expect(service.undo('x')).rejects.toMatchObject({ category: 'validation_error', message: 'Kein Undo-Handler für „unbekannt“.' });
  });

  it('picks the handler matching the action type', async () => {
    const { service } = setup(row({ undoType: 'b' }));
    const a = vi.fn(async () => 'a');
    const b = vi.fn(async () => 'b');
    service.register('a', handler({ run: a }));
    service.register('b', handler({ run: b }));

    expect((await service.undo('x')).message).toBe('b');
    expect(a).not.toHaveBeenCalled();
  });

  it('overwrites nothing on conflicts: the handler does not run, nothing is marked or logged, the conflicts are returned', async () => {
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
    expect(logger.warn).toHaveBeenCalledWith('undo', 'Undo rejected because of conflicts', { auditId: 'audit-7', conflicts: ['Ziel wurde verändert'] });
  });

  it('checks the conflicts with the undo data of the action', async () => {
    const { service } = setup(row({ undoData: { id: 42 } }));
    const check = vi.fn(async () => []);
    service.register('archive.move', handler({ check }));

    await service.undo('x');

    expect(check).toHaveBeenCalledWith({ id: 42 });
  });

  it('logs a failed handler as an error, marks nothing and passes the error on', async () => {
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

  it('also logs errors that are not Error objects', async () => {
    const { service, audit } = setup(row());
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of this test is an error that is not an Error object
    service.register('archive.move', handler({ run: async () => Promise.reject('kaputt') }));

    await expect(service.undo('x')).rejects.toBe('kaputt');

    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'kaputt' }));
  });
});

describe('composite undo', () => {
  const compositeRow = (steps: Array<{ type: string; data: unknown }>) => row({ undoType: COMPOSITE_UNDO_TYPE, undoData: { steps } });
  const twoSteps = [
    { type: 'a', data: { n: 1 } },
    { type: 'b', data: { n: 2 } },
  ];

  it('runs the steps in reverse order with their own data and joins their messages', async () => {
    const { service } = setup(compositeRow(twoSteps));
    const calls: unknown[] = [];
    service.register('a', handler({ run: async (data) => (calls.push(['a', data]), 'Erster zurück.') }));
    service.register('b', handler({ run: async (data) => (calls.push(['b', data]), 'Zweiter zurück.') }));

    const result = await service.undo('x');

    expect(result).toEqual({ undone: true, message: 'Zweiter zurück. Erster zurück.', conflicts: [] });
    expect(calls).toEqual([
      ['b', { n: 2 }],
      ['a', { n: 1 }],
    ]);
  });

  it('collects the conflicts of every step and then runs none of them', async () => {
    const { service } = setup(compositeRow(twoSteps));
    const run = vi.fn(async () => 'x');
    service.register('a', handler({ check: async (data) => [`a: ${JSON.stringify(data)}`], run }));
    service.register('b', handler({ check: async () => ['b1', 'b2'], run }));

    const result = await service.undo('x');

    expect(result).toMatchObject({ undone: false, conflicts: ['a: {"n":1}', 'b1', 'b2'] });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a step whose type has no handler and names the type', async () => {
    const { service } = setup(compositeRow([{ type: 'verschwunden', data: {} }]));

    await expect(service.undo('x')).rejects.toMatchObject({ category: 'validation_error', message: 'Kein Undo-Handler für „verschwunden“.' });
  });
});
