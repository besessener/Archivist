import { describe, expect, it, vi } from 'vitest';
import { recoverFromDamagedDatabase, type RecoveryDeps } from '../../apps/desktop/src/recovery';

const paths = { root: '/data', database: '/data/database', backups: '/data/backups' };
const source = { name: 'metadaten-2026-10-01', databaseFile: '/data/backups/x/archivist.db', createdAt: '2026-10-01T08:00:00.000Z', archive: null };

function setup(overrides: Partial<RecoveryDeps> = {}) {
  const deps: RecoveryDeps = {
    paths,
    scheduleNewestRestore: vi.fn(() => source),
    askToRestore: vi.fn(() => true),
    showError: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe('start with a damaged database', () => {
  it('restores the newest backup after consent and starts again', () => {
    const deps = setup();

    recoverFromDamagedDatabase(deps, 'Die Datenbank ist beschädigt.');

    expect(deps.scheduleNewestRestore).toHaveBeenCalledWith(paths);
    expect(deps.askToRestore).toHaveBeenCalledWith(expect.objectContaining({ backupName: source.name, message: expect.stringContaining('2026-10-01') }));
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('quits without restarting when the user declines', () => {
    const deps = setup({ askToRestore: vi.fn(() => false) });

    recoverFromDamagedDatabase(deps, 'Die Datenbank ist beschädigt.');

    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('explains that there is no backup and keeps the archive files untouched', () => {
    const deps = setup({ scheduleNewestRestore: vi.fn(() => null) });

    recoverFromDamagedDatabase(deps, 'Die Datenbank ist beschädigt.');

    expect(deps.askToRestore).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith('Archivist konnte nicht gestartet werden', expect.stringContaining('kein Backup'));
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});
