import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('backups', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('a backup can be restored: confirmation first, then the restore is prepared for the next start', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    await app.navigation.do.open('settings');
    await app.settings.do.openBackups();
    await app.settings.locators.backups.createMetadata.click();
    await expect(app.settings.locators.backups.rows).toHaveCount(1);
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.settings.locators.backups.restore.click();
    await expect(app.settings.locators.backups.confirmRestore).toBeVisible();
    await page.keyboard.press('Escape');
    expect(fs.existsSync(path.join(workspace.dataDir, 'restore-pending.json')), 'nothing is scheduled before the confirmation').toBe(false);

    await app.settings.locators.backups.restore.click();
    await app.settings.locators.backups.confirmRestore.click();

    await expect(app.settings.locators.backups.restartNotice).toBeVisible();
    expect(fs.existsSync(path.join(workspace.dataDir, 'restore-pending.json'))).toBe(true);
  });

  test('shows how much space the database and the backups take, without a warning for a small archive (#225)', async ({ on, page }, testInfo) => {
    const app = on(page);
    await app.navigation.do.open('settings');
    await app.settings.do.openBackups();
    await app.settings.locators.backups.createMetadata.click();
    await expect(app.settings.locators.backups.rows).toHaveCount(1);

    await expect(app.settings.locators.backups.storage).toContainText('Datenbank:');
    await expect(app.settings.locators.backups.sizeWarning).toBeHidden();
    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test('the database a restore replaced is offered as a source and can be restored the same way', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const backups = app.settings.locators.backups;
    await app.navigation.do.open('settings');
    await app.settings.do.openBackups();
    await backups.createMetadata.click();
    await expect(backups.rows).toHaveCount(1);
    const backupFolder = path.join(workspace.dataDir, 'backups');
    const backupDatabase = path.join(backupFolder, fs.readdirSync(backupFolder)[0]!, 'archivist.db');
    const asideName = 'vor-wiederherstellung-2026-10-01T10-00-00-000';
    const aside = path.join(workspace.dataDir, 'database', asideName);
    fs.mkdirSync(aside, { recursive: true });
    fs.copyFileSync(backupDatabase, path.join(aside, 'archivist.db'));
    await backups.createMetadata.click();
    await expect(backups.rows).toHaveCount(3);

    await expect(backups.beforeRestoreRow).toHaveCount(1);
    await expectNoSeriousA11yViolations(page, testInfo);
    await backups.beforeRestoreRow.getByTestId('backup-restore').click();
    await expect(backups.confirmRestore).toBeVisible();
    await expect(backups.confirmDialog).toContainText('Stand vor der Wiederherstellung vom');
    await backups.confirmRestore.click();

    await expect(backups.restartNotice).toBeVisible();
    const marker = JSON.parse(fs.readFileSync(path.join(workspace.dataDir, 'restore-pending.json'), 'utf8')) as { name: string };
    expect(marker.name).toBe(asideName);
  });
});
