import { expect, test } from './fixture';

test.describe('app updates', () => {
  test('a development build explains that it cannot update itself and offers no buttons', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openUpdates();

    await expect(app.settings.locators.updates.status).toHaveText('In der Entwicklungsversion gibt es keine Updates.');
    await expect(app.settings.locators.updates.check).toHaveCount(0);
    await expect(app.settings.locators.updates.startup).toHaveCount(0);
  });
});
