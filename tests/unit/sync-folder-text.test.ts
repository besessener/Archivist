import { describe, expect, it } from 'vitest';
import { syncedFolderContents } from '../../apps/renderer/lib/sync-folder-text';

describe('syncedFolderContents', () => {
  it('keeps database, settings and backups out of a synced data folder in the default layout', () => {
    const text = syncedFolderContents({ archive: null, data: 'OneDrive', appStateInDataRoot: false });
    expect(text).toContain('Im Datenordner liegen Eingang, Quarantäne und Papierkorb');
    expect(text).toContain('Datenbank, Einstellungen und Backups liegen getrennt davon im Datenordner deines Benutzerprofils');
  });

  it('names database, settings and backups in the synced data folder when everything lies there', () => {
    expect(syncedFolderContents({ archive: null, data: 'OneDrive', appStateInDataRoot: true })).toBe(
      'Im Datenordner liegen Eingang, Quarantäne, Papierkorb, Datenbank, Einstellungen und Backups.',
    );
  });

  it('says that both folders are synced', () => {
    expect(syncedFolderContents({ archive: 'Dropbox', data: 'OneDrive', appStateInDataRoot: false })).toMatch(
      /^Das gilt für den Archivordner und den Datenordner\. /,
    );
  });

  it('places database, settings and backups outside a synced archive folder in either layout', () => {
    expect(syncedFolderContents({ archive: 'Dropbox', data: null, appStateInDataRoot: false })).toBe(
      'Datenbank, Einstellungen und Backups liegen im Datenordner deines Benutzerprofils.',
    );
    expect(syncedFolderContents({ archive: 'Dropbox', data: null, appStateInDataRoot: true })).toBe(
      'Datenbank, Einstellungen und Backups liegen im Datenordner, nicht im Archivordner.',
    );
  });
});
