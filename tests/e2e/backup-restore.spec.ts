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
});
