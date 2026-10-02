import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import { SECTIONS } from './pages/navigation';

test.describe('accessibility (axe, WCAG 2.2 AA)', () => {
  test('the setup wizard has no serious or critical violations', async ({ on, page }, testInfo) => {
    await expect(on(page).setup()).toBeVisible();

    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test.describe('after setup', () => {
    test.beforeEach(async ({ llm, on, page }) => {
      await on(page).setup.do.complete(llm.url);
    });

    for (const section of SECTIONS) {
      test(`section "${section}" has no serious or critical violations`, async ({ on, page }, testInfo) => {
        await on(page).navigation.do.open(section);
        await expect(on(page).navigation.locators.link(section)).toHaveAttribute('aria-current', 'page');

        await expectNoSeriousA11yViolations(page, testInfo);
      });
    }

    test('the agent settings (runs, link run) have no serious or critical violations', async ({ on, page }, testInfo) => {
      await on(page).navigation.do.open('settings');
      await page.getByTestId('tab-agent').click();
      await page.getByTestId('agent-tab-runs').click();
      await expect(page.getByTestId('links-start-run')).toBeVisible();
      await expect(page.getByTestId('links-unlinked-count')).toHaveText('Alle Einträge sind verknüpft.');

      await expectNoSeriousA11yViolations(page, testInfo);
    });
  });
});
