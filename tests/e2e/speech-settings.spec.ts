import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('settings: speech input', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
    await on(page).navigation.do.open('settings');
    await on(page).settings.locators.tabs.profile.click();
  });

  test('lists the models, downloads the chosen one and deletes it again', async ({ on, page }) => {
    const { speech } = on(page).settings.locators;
    await expect(speech.model).toHaveValue('small');
    for (const name of ['small', 'medium', 'turbo']) await expect(speech.state(name)).toHaveText('nicht heruntergeladen');

    await speech.install.click();
    await expect(speech.state('small')).toHaveText('heruntergeladen');
    await expect(speech.install).toHaveCount(0);
    await expect(speech.state('medium')).toHaveText('nicht heruntergeladen');

    await speech.remove('small').click();
    await speech.removeConfirm.click();

    await expect(speech.state('small')).toHaveText('nicht heruntergeladen');
    await expect(speech.install).toBeVisible();
  });

  test('remembers the chosen model', async ({ on, page }) => {
    const { speech } = on(page).settings.locators;
    await speech.model.selectOption('turbo');
    await expect(speech.model).toHaveValue('turbo');

    await page.reload();
    await on(page).settings.locators.tabs.profile.click();

    await expect(speech.model).toHaveValue('turbo');
  });

  test('shows the progress of a download and lets it be cancelled', async ({ on, page, speechModel }) => {
    const { speech } = on(page).settings.locators;
    speechModel.hold();

    await speech.install.click();
    await expect(speech.download).toBeVisible();
    await expect(speech.state('small')).toHaveText('wird heruntergeladen …');
    await speech.cancel.click();
    speechModel.release();

    await expect(speech.download).toHaveCount(0);
    await expect(speech.state('small')).toHaveText('nicht heruntergeladen');
  });

  test('says so when the download fails', async ({ on, page, speechModel }) => {
    const { speech } = on(page).settings.locators;
    speechModel.corrupt('config.json');

    await speech.install.click();

    await expect(speech.error).toContainText('config.json');
  });

  test('has no serious or critical accessibility violations', async ({ on, page }, testInfo) => {
    const { speech } = on(page).settings.locators;
    await speech.install.click();
    await expect(speech.state('small')).toHaveText('heruntergeladen');

    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
