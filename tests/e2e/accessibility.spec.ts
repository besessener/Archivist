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

    test('the page of proposed decisions has no serious or critical violations', async ({ on, page }, testInfo) => {
      const { decisions, navigation } = on(page);
      await navigation.do.open('decisions');
      await decisions.locators.proposed.open.click();
      await expect(page.getByRole('heading', { name: 'Vorgeschlagene Entscheidungen' })).toBeVisible();
      await expect(decisions.locators.proposed.back).toBeVisible();

      await expectNoSeriousA11yViolations(page, testInfo);
    });

    test('the agent settings (runs, link run) have no serious or critical violations', async ({ on, page }, testInfo) => {
      await on(page).navigation.do.open('settings');
      await page.getByTestId('tab-agent').click();
      await page.getByTestId('agent-tab-runs').click();
      await expect(page.getByTestId('links-start-run')).toBeVisible();
      await expect(page.getByTestId('links-unlinked-count')).toHaveText('Alle Einträge sind verknüpft.');

      await expectNoSeriousA11yViolations(page, testInfo);
    });

    test('what Archivist has learned (list and rule form) has no serious or critical violations', async ({ on, page }, testInfo) => {
      const { settings } = on(page);
      await on(page).navigation.do.open('settings');
      await settings.do.openLearned();
      await settings.do.addRule({
        name: 'Stadtwerke',
        content: 'Rechnungen nach energie',
        when: { 'Absender enthält': 'Stadtwerke' },
        then: { Ablageordner: 'Privat/energie' },
      });
      await expect(settings.locators.memory.entry('Stadtwerke')).toBeVisible();
      await expectNoSeriousA11yViolations(page, testInfo);

      await settings.locators.memory.edit('Stadtwerke').click();
      await expect(settings.locators.memory.dialog.field('Absender enthält')).toHaveValue('Stadtwerke');
      await expectNoSeriousA11yViolations(page, testInfo);
    });

    test('a decision with its history and the change log have no serious or critical violations', async ({ on, page }, testInfo) => {
      const { decisions, navigation, settings } = on(page);
      await navigation.do.open('decisions');
      await decisions.do.create({ text: 'Wir nutzen SQLite.', isoDate: '2026-10-01', topic: 'Datenbank', participants: 'Anna' });
      await decisions.row('Wir nutzen SQLite.').click();
      await expect(decisions()).toBeVisible();
      await expectNoSeriousA11yViolations(page, testInfo);

      await decisions.locators.tabs.history.click();
      await expect(decisions.locators.history.entries.first()).toBeVisible();
      await expectNoSeriousA11yViolations(page, testInfo);

      await navigation.do.open('settings');
      await settings.do.openAudit();
      await expect(settings.locators.audit.rows.first()).toBeVisible();
      await expect(settings.locators.audit.chainOk).toBeVisible();
      await expectNoSeriousA11yViolations(page, testInfo);
    });

    test('the agent settings with the limits per background task have no serious or critical violations', async ({ on, page }, testInfo) => {
      await on(page).navigation.do.open('settings');
      await on(page).settings.do.openAgent();
      await expect(on(page).settings.locators.agent.kindLimits).toBeVisible();

      await expectNoSeriousA11yViolations(page, testInfo);
    });
  });
});
