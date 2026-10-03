import { describe, expect, it } from 'vitest';
import { detectSyncFolder } from '../../packages/core/src/util/sync-folders';
import { assessBackupSize, BACKUP_SIZE_WARNING_BYTES } from '../../packages/shared/src/backup-size';

describe('Sync folder detection (#207)', () => {
  it.each([
    ['C:\\Users\\Anna\\OneDrive\\Dokumente\\Archivist\\archive', 'OneDrive'],
    ['C:\\Users\\Anna\\OneDrive - Firma GmbH\\Archiv', 'OneDrive'],
    ['C:\\Users\\Anna\\OneDrive-Personal\\Archiv', 'OneDrive'],
    ['/home/anna/Dropbox/Archiv', 'Dropbox'],
    ['D:\\Dropbox (Privat)\\Archiv', 'Dropbox'],
    ['/Users/anna/Library/Mobile Documents/com~apple~CloudDocs/Archiv', 'iCloud Drive'],
    ['C:\\Users\\Anna\\iCloudDrive\\Archiv', 'iCloud Drive'],
    ['G:\\My Drive\\Archiv', 'Google Drive'],
    ['G:\\Meine Ablage\\Archiv', 'Google Drive'],
    ['C:\\Users\\Anna\\Google Drive\\Archiv', 'Google Drive'],
    ['/Users/anna/GoogleDrive/Archiv', 'Google Drive'],
  ])('%s lies in %s', (folder, provider) => {
    expect(detectSyncFolder(folder)).toBe(provider);
  });

  it.each(['C:\\Users\\Anna\\Documents\\Archivist\\archive', '/home/anna/Dokumente/Archivist', '/srv/onedrivexyz/archiv', '/home/anna/mydropbox/x', ''])(
    '%s is no sync folder',
    (folder) => {
      expect(detectSyncFolder(folder)).toBeNull();
    },
  );
});

describe('Backup size assessment (#225)', () => {
  const GIB = 1024 ** 3;

  it('stays quiet for a small database with few backups', () => {
    expect(assessBackupSize({ databaseBytes: 100 * 1024 ** 2, backupsBytes: 200 * 1024 ** 2, keep: 3 })).toEqual({
      metadataWorstCaseBytes: 300 * 1024 ** 2,
      large: false,
    });
  });

  it('warns when the kept metadata backups can reach the limit', () => {
    expect(assessBackupSize({ databaseBytes: GIB, backupsBytes: 0, keep: 2 })).toEqual({ metadataWorstCaseBytes: 2 * GIB, large: true });
    expect(assessBackupSize({ databaseBytes: GIB - 1, backupsBytes: 0, keep: 2 }).large).toBe(false);
  });

  it('warns when the backups already take that much, e.g. full backups', () => {
    expect(assessBackupSize({ databaseBytes: 1, backupsBytes: BACKUP_SIZE_WARNING_BYTES, keep: 1 }).large).toBe(true);
    expect(assessBackupSize({ databaseBytes: 1, backupsBytes: BACKUP_SIZE_WARNING_BYTES - 1, keep: 1 }).large).toBe(false);
  });
});
