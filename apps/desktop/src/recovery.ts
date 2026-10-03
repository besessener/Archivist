// Start with a damaged database: offers the newest intact backup; free of Electron so it can be unit-tested.
import type { RestorePaths, RestoreSource } from '@archivist/core';

export interface RecoveryDeps {
  paths: RestorePaths;
  scheduleNewestRestore: (paths: RestorePaths) => RestoreSource | null;
  /** Shows the offer; true when the user wants the restore. */
  askToRestore: (question: { message: string; backupName: string }) => boolean;
  showError: (title: string, message: string) => void;
  /** Starts a new instance after this one has exited. */
  relaunch: () => void;
  exit: (code: number) => void;
}

/** Handles a database found damaged at start: restore after the user's consent (the damaged file is kept), else quit. */
export function recoverFromDamagedDatabase(deps: RecoveryDeps, problem: string): void {
  const source = deps.scheduleNewestRestore(deps.paths);
  if (!source) {
    deps.showError(
      'Archivist konnte nicht gestartet werden',
      `${problem}\n\nEs gibt kein Backup, aus dem die Datenbank wiederhergestellt werden könnte. Deine Dokumente im Archivordner sind unverändert.`,
    );
    deps.exit(1);
    return;
  }
  const accepted = deps.askToRestore({
    message: `${problem}\n\nNeuestes unbeschädigtes Backup: ${source.name} (${source.createdAt.slice(0, 10)}). Änderungen seit diesem Backup gehen dabei verloren; die beschädigte Datenbank bleibt im Datenordner erhalten.`,
    backupName: source.name,
  });
  if (!accepted) {
    deps.exit(1);
    return;
  }
  deps.relaunch();
  deps.exit(0);
}
