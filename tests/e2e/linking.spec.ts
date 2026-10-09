import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { flatText } from '../helpers/link-texts';
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
    // a plain wheel scrolls the page, Ctrl+wheel (and a touchpad pinch) zooms; pan by dragging, then fullscreen and back with Escape
    const svg = page.getByTestId('graph-svg');
    await svg.scrollIntoViewIfNeeded();
    let box = (await svg.boundingBox())!;
    // left of the centre, away from the toast in the bottom right corner
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect(svg).toHaveAttribute('data-view', '0,0,720');
    await svg.scrollIntoViewIfNeeded();
    box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await expect(svg).not.toHaveAttribute('data-view', '0,0,720');
    const zoomed = await svg.getAttribute('data-view');
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 60);
    await page.mouse.up();
    await expect(svg).not.toHaveAttribute('data-view', zoomed!);
    await page.getByTestId('graph-zoom-reset').click();
    await expect(svg).toHaveAttribute('data-view', '0,0,720');
    await page.getByTestId('graph-fullscreen').click();
    await expect(page.getByTestId('graph-view')).toHaveAttribute('data-fullscreen', 'true');
    // in fullscreen a plain wheel pans the view
    box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.wheel(0, 100);
    await expect(svg).not.toHaveAttribute('data-view', '0,0,720');
    await expectNoSeriousA11yViolations(page, testInfo);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('graph-view')).toHaveAttribute('data-fullscreen', 'false');
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

  test('typing right after choosing a wiki suggestion keeps the text in order, even when the next frame is late', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'project', name: 'Hausbau' });
    // a slow machine: the next animation frame only arrives while the user is already typing on
    await page.evaluate(() => {
      const later = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => window.setTimeout(() => later(callback), 60);
    });

    await k.locators.buttons.create.click();
    await k.locators.inputs.type.selectOption('note');
    await k.locators.inputs.name.fill('Baustelle');
    await k.locators.inputs.description.pressSequentially('Termin zu [[Haus');
    await page.getByTestId('wiki-suggestion').filter({ hasText: 'Hausbau' }).click();
    await k.locators.inputs.description.pressSequentially(' und [[Unbekannt]]', { delay: 20 });

    await expect(k.locators.inputs.description).toHaveValue('Termin zu [[Hausbau]] und [[Unbekannt]]');
    await expect(page.getByTestId('wiki-unknown')).toContainText('„Unbekannt“ als Notiz anlegen');
  });

  test('choosing a wiki suggestion before another link on the same line keeps that link', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'project', name: 'Hausbau' });

    await k.locators.buttons.create.click();
    await k.locators.inputs.type.selectOption('note');
    await k.locators.inputs.name.fill('Baustelle');
    await k.locators.inputs.description.fill('Termin mit  und [[Anna]] morgen');
    await k.locators.inputs.description.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(11, 11));
    await k.locators.inputs.description.pressSequentially('[[Haus');
    await page.getByTestId('wiki-suggestion').filter({ hasText: 'Hausbau' }).click();

    await expect(k.locators.inputs.description).toHaveValue('Termin mit [[Hausbau]] und [[Anna]] morgen');
  });

  test('searching links for one entry proposes a similar entry, which is confirmed there (#313)', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'note', name: 'Nebenkosten', description: flatText('Nebenkosten') });
    await k.do.create({ type: 'note', name: 'Mietvertrag', description: flatText('Mietvertrag') });
    await expect(k.heading()).toHaveText('Mietvertrag');

    await k.locators.scanLinks.click();
    await expect(k.locators.scanResult).toBeVisible();
    const similar = k.locators.relatedEntries.filter({ hasText: 'Nebenkosten' });
    await expect(similar).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
    await similar.getByTestId('related-confirm').click();
    await expect(k.locators.toasts.filter({ hasText: 'Bestätigt' })).toBeVisible();
  });

  test('the unlink dialog of an incoming link states it in its stored direction', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'case', name: 'Autokauf' });
    await k.do.create({ type: 'note', name: 'Probefahrt' });
    await expect(k.heading()).toHaveText('Probefahrt');
    await page.getByTestId('knowledge-case').click();
    await page.getByTestId('case-assign-choice').selectOption({ label: 'Autokauf (0 Einträge)' });
    await page.getByTestId('case-assign-save').click();
    await expect(k.locators.toasts.filter({ hasText: 'Zum Vorgang hinzugefügt' })).toBeVisible();

    await k().filter({ hasText: 'Autokauf' }).click();
    await expect(k.heading()).toHaveText('Autokauf');
    await page.getByTestId('relation-row').filter({ hasText: 'Probefahrt' }).getByTestId('relation-unlink').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('„Probefahrt“ gehört zu „Autokauf“');
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
