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

test.describe('app updates of an installed version', () => {
  test.use({ updateVersion: '9.9.9' });

  test('the announcement leads to the updates, where the new version is downloaded and installed only on request', async ({ llm, on, page }) => {
    const app = on(page);
    const { updates } = app.settings.locators;
    // the check at start-up already announces the version, also over the setup wizard
    await expect(updates.announcement).toContainText('Version 9.9.9 ist verfügbar');
    await updates.announcement.getByRole('button', { name: 'Meldung schließen' }).click();
    await app.setup.do.complete(llm.url);

    await page.reload(); // the finished app announces it once more
    await updates.announcement.getByRole('button', { name: 'Zu den Updates' }).click();
    await expect(page).toHaveURL(/tab=maintenance/);
    await expect(updates.status).toHaveText('Version 9.9.9 ist verfügbar.');
    await expect(updates.check).toBeDisabled();
    await expect(updates.install).toHaveCount(0);

    await updates.download.click();
    await expect(updates.status).toHaveText('Version 9.9.9 ist heruntergeladen und bereit zur Installation.');
    await expect(updates.download).toHaveCount(0);

    await updates.install.click();
    await expect(updates.status).toContainText('Version 9.9.9 wird installiert');
    await expect(updates.install).toHaveText('Wird installiert …');
    await expect(updates.install).toBeDisabled();
    await expect(updates.check).toBeDisabled();
  });
});
