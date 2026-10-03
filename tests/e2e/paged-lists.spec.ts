import { expectNoSeriousA11yViolations } from './axe';
import { seedLongLists } from './helpers';
import { expect, test as base } from './fixture';

/** 105 decisions and 105 open insights: more than one page of each. */
const test = base.extend({
  workspace: async ({ workspace }, provide) => {
    seedLongLists(workspace.dataDir, 105);
    await provide(workspace);
  },
});

test.describe('long lists load page by page (#223)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('decisions show the newest 100 with „N von M“ and „Mehr laden“ adds the rest', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('decisions');
    const decisions = app.decisions.locators;

    await expect(decisions.rows).toHaveCount(100);
    await expect(decisions.capped).toContainText('Angezeigt werden 100 von 105 Entscheidungen.');
    await expect(decisions.rows.filter({ hasText: 'Wir entscheiden Nummer 1.' })).toHaveCount(0);

    await decisions.loadMore.click();

    await expect(decisions.rows).toHaveCount(105);
    await expect(decisions.capped).toBeHidden();
  });

  test('insights show the newest 100 with „N von M“ and „Mehr laden“ adds the rest', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('insights');
    const insights = app.insights.locators;

    await expect(insights.cards).toHaveCount(100);
    await expect(insights.capped).toContainText('Angezeigt werden 100 von 105 Hinweisen.');

    await insights.loadMore.click();

    await expect(insights.cards).toHaveCount(105);
    await expect(insights.capped).toBeHidden();
  });

  test('the paged decisions and insights have no serious or critical violations', async ({ on, page }, testInfo) => {
    const app = on(page);
    await app.navigation.do.open('decisions');
    await expect(app.decisions.locators.capped).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.navigation.do.open('insights');
    await expect(app.insights.locators.capped).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
