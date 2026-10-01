import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import { SECTIONS } from './pages/navigation';

test.describe('Barrierefreiheit (axe, WCAG 2.2 AA)', () => {
  test('der Einrichtungsdialog hat keine schweren oder kritischen Verstöße', async ({ on, page }, testInfo) => {
    await expect(on(page).setup()).toBeVisible();

    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test.describe('nach der Einrichtung', () => {
    test.beforeEach(async ({ llm, on, page }) => {
      await on(page).setup.do.complete(llm.url);
    });

    for (const section of SECTIONS) {
      test(`der Bereich „${section}“ hat keine schweren oder kritischen Verstöße`, async ({ on, page }, testInfo) => {
        await on(page).navigation.do.open(section);
        await expect(on(page).navigation.locators.link(section)).toHaveAttribute('aria-current', 'page');

        await expectNoSeriousA11yViolations(page, testInfo);
      });
    }
  });
});
