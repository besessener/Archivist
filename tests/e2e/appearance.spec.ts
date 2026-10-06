import type { Page } from '@playwright/test';
import { expect, test } from './fixture';

/** The page background: the canvas colour of the active scheme. */
const canvas = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const DARK_CANVAS = 'rgb(22, 22, 26)';
const LIGHT_CANVAS = 'rgb(247, 247, 249)';

test.describe('colour scheme', () => {
  test('„Dunkel“ and „Hell“ in Darstellung switch the window at once; the choice is kept', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.locators.tabs.appearance.click();
    await expect(app.settings.locators.theme).toHaveValue('system');
    await expect.poll(() => canvas(page)).toBe(LIGHT_CANVAS);

    await app.settings.do.setTheme('dark');
    await expect.poll(() => canvas(page)).toBe(DARK_CANVAS);

    await app.settings.do.setTheme('light');
    await expect.poll(() => canvas(page)).toBe(LIGHT_CANVAS);

    await app.navigation.do.open('chat');
    await app.navigation.do.open('settings');
    await app.settings.locators.tabs.appearance.click();
    await expect(app.settings.locators.theme).toHaveValue('light');
  });
});
