import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('German main categories (#233)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('a fresh archive offers no migration and starts with Arbeit and Privat', async ({ on, page }) => {
    const { navigation, settings } = on(page);
    await navigation.do.open('settings');
    await settings.do.openArchive();

    await expect(settings.locators.categories.list).toContainText('Arbeit');
    await expect(settings.locators.categories.list).toContainText('Privat');
    await expect(settings.locators.categoryMigration.plan).toHaveCount(0);
  });

  test('renames an English main category after a preview and a second, explicit confirmation, as a job', async ({ on, page }, testInfo) => {
    const { navigation, settings } = on(page);
    const migration = settings.locators.categoryMigration;
    await navigation.do.open('settings');
    await settings.do.openArchive();
    await settings.do.createCategory('work/projects');

    await expect(migration.plan).toContainText('work');
    await expectNoSeriousA11yViolations(page, testInfo);
    await migration.start.click();
    await expect(migration.confirm).toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);
    await migration.confirmCheckbox.click();
    await migration.confirm.click();

    await expect(migration.job).toContainText('Kategorie-Einträge umbenannt');
    await expect(settings.locators.categories.list).toContainText('Arbeit/projects');
    await expect(settings.locators.categories.list).not.toContainText('work');
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
