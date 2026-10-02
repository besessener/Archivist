import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

/** Optional screenshots for a visual check (ARCHIVIST_E2E_SHOTS=<folder>). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.ARCHIVIST_E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

test.describe('linking knowledge (Epic #269)', () => {
  test('wiki links with autocomplete, a case with its page, the graph of an entry (#285, #286, #288)', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'project', name: 'Hausbau' });
    await k.do.create({ type: 'note', name: 'Statik', description: 'Statiker beauftragt.' });

    // [[ offers the entries; choosing one inserts the link
    await k.locators.buttons.create.click();
    await k.locators.inputs.type.selectOption('note');
    await k.locators.inputs.name.fill('Baustelle');
    await k.locators.inputs.description.pressSequentially('Termin zu [[Haus');
    await expect(page.getByTestId('wiki-suggestion').filter({ hasText: 'Hausbau' })).toBeVisible();
    await shot(page, 'wiki-autocomplete');
    await page.getByTestId('wiki-suggestion').filter({ hasText: 'Hausbau' }).click();
    await expect(k.locators.inputs.description).toHaveValue('Termin zu [[Hausbau]]');
    await k.locators.inputs.description.pressSequentially(' und [[Unbekannt]]');
    await expect(page.getByTestId('wiki-unknown')).toContainText('„Unbekannt“ als Notiz anlegen');
    await k.locators.buttons.save.click();
    await expect(k.heading()).toHaveText('Baustelle');
    await expect(page.getByTestId('wiki-link')).toHaveText('Hausbau');
    await expect(page.getByTestId('wiki-link-unknown')).toHaveText('Unbekannt');

    // a case: create, add the note, its page lists it
    await k.do.create({ type: 'case', name: 'Autokauf' });
    await expect(k.heading()).toHaveText('Autokauf');
    await expect(page.getByTestId('case-view')).toBeVisible();
    await k().filter({ hasText: 'Baustelle' }).click();
    await page.getByTestId('knowledge-case').click();
    await page.getByTestId('case-assign-choice').selectOption({ label: 'Autokauf (0 Einträge)' });
    await page.getByTestId('case-assign-save').click();
    await expect(k.locators.toasts.filter({ hasText: 'Zum Vorgang hinzugefügt' })).toBeVisible();

    // the graph of the note: the project, the case and the wiki link
    await page.getByTestId('knowledge-graph').click();
    await expect(page.getByTestId('graph-node')).toHaveCount(3);
    await page.getByTestId('graph-node').filter({ hasText: 'Autokauf' }).click();
    await expect(page.getByTestId('graph-selection')).toContainText('Autokauf');
    await shot(page, 'graph');
    await expectNoSeriousA11yViolations(page, testInfo);
    await page.getByTestId('graph-open').click();
    await expect(k.heading()).toHaveText('Autokauf');
    await expect(page.getByTestId('case-entry').filter({ hasText: 'Baustelle' })).toBeVisible();
    await shot(page, 'case');
    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test('bulk assignment of open items and the linkage metrics under Insights (#291, #292)', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    for (const title of ['Strom ummelden', 'Nachsendeauftrag stellen']) {
      await page.getByTestId('open-item-new').click();
      await page.getByTestId('open-item-title').fill(title);
      await page.getByTestId('open-item-save').click();
      await expect(page.getByTestId('open-item-row').filter({ hasText: title })).toBeVisible();
    }
    for (const box of await page.getByTestId('open-item-select').all()) await box.check();
    await expect(page.getByTestId('entries-bulk-bar')).toContainText('2 offene Punkte ausgewählt');
    await page.getByTestId('entries-bulk-assign').click();
    await page.getByTestId('entries-assign-topic').fill('Umzug');
    await shot(page, 'bulk-dialog');
    await page.getByTestId('entries-assign-save').click();
    await expect(page.getByTestId('entries-bulk-result')).toContainText('2 offene Punkte zugeordnet');
    await expect(page.getByTestId('open-item-row').filter({ hasText: 'Umzug' })).toHaveCount(2);
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.navigation.do.open('insights');
    await page.getByTestId('consistency-run').click();
    await expect(page.getByTestId('linkage-metrics')).toBeVisible();
    await expect(page.getByTestId('linkage-orphans')).toContainText('von 2 Einträgen');
    await page.getByTestId('linkage-rate').click();
    await expect(page.getByTestId('linkage-methods')).toBeVisible();
    // a second archive check: the history shows a trend
    await page.getByTestId('consistency-run').click();
    await expect(page.getByTestId('linkage-metrics').getByRole('img', { name: /Verlauf/ })).toBeVisible();
    await shot(page, 'insights');
    await expectNoSeriousA11yViolations(page, testInfo);

    // what the link methods learned from rejections (#275): viewable and resettable
    await app.navigation.do.open('settings');
    await page.getByTestId('tab-agent').click();
    await page.getByTestId('agent-tab-runs').click();
    await expect(page.getByTestId('links-threshold-row')).toHaveCount(2);
    await page.getByTestId('links-thresholds').scrollIntoViewIfNeeded();
    await shot(page, 'thresholds');
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
