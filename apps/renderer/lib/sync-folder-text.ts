interface SyncedFolders {
  /** Cloud service that synchronises the archive folder. */
  archive: string | null;
  /** Cloud service that synchronises the data folder. */
  data: string | null;
  /** Database, settings and backups lie in the data folder too (ARCHIVIST_DATA_DIR). */
  appStateInDataRoot: boolean;
}

/** Which of Archivist's files lie in the synchronised folders, for the warning about them. */
export function syncedFolderContents({ archive, data, appStateInDataRoot }: SyncedFolders): string {
  if (!data) {
    return appStateInDataRoot
      ? 'Datenbank, Einstellungen und Backups liegen im Datenordner, nicht im Archivordner.'
      : 'Datenbank, Einstellungen und Backups liegen im Datenordner deines Benutzerprofils.';
  }
  const both = archive ? 'Das gilt für den Archivordner und den Datenordner. ' : '';
  return appStateInDataRoot
    ? `${both}Im Datenordner liegen Eingang, Quarantäne, Papierkorb, Datenbank, Einstellungen und Backups.`
    : `${both}Im Datenordner liegen Eingang, Quarantäne und Papierkorb, also Kopien deiner Dokumente; Datenbank, Einstellungen und Backups liegen getrennt davon im Datenordner deines Benutzerprofils.`;
}
