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

  test('renames an English main category after a preview and a confirmation', async ({ on, page }, testInfo) => {
    const { navigation, settings } = on(page);
    await navigation.do.open('settings');
    await settings.do.openArchive();
    await settings.do.createCategory('work/projects');

    await expect(settings.locators.categoryMigration.plan).toContainText('work');
    await expectNoSeriousA11yViolations(page, testInfo);
    await settings.locators.categoryMigration.start.click();
    await settings.locators.categoryMigration.confirm.click();

    await expect(settings.locators.categoryMigration.result).toContainText('Kategorie-Einträge umbenannt');
    await expect(settings.locators.categories.list).toContainText('Arbeit/projects');
    await expect(settings.locators.categories.list).not.toContainText('work');
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
