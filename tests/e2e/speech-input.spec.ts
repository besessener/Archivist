import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('chat: speech input', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('sets up once, then dictates into the input field without sending anything', async ({ on, page }) => {
    const { dictation, inputs, messages } = on(page).chat.locators;
    await expect(dictation.toggle).toHaveAttribute('data-state', 'not_installed');

    await on(page).chat.do.startDictationSetup();
    await expect(dictation.toggle).toHaveAttribute('data-state', 'idle');

    await inputs.message.fill('Notiz:');
    await dictation.toggle.click();
    await expect(dictation.toggle).toHaveAttribute('data-state', 'recording');
    await expect(dictation.status).toContainText('Aufnahme läuft');
    await page.waitForTimeout(1_500); // the synthetic microphone beeps once a second
    await dictation.toggle.click();

    await expect(inputs.message).toHaveValue(/^Notiz: test-small hörte \d+ Werte$/);
    await expect(dictation.toggle).toHaveAttribute('data-state', 'idle');
    await expect(messages).toHaveCount(0);
  });

  test('stays set up after a reload, without a second download', async ({ on, page, speechModel }) => {
    await on(page).chat.do.startDictationSetup();
    await expect(on(page).chat.locators.dictation.toggle).toHaveAttribute('data-state', 'idle');

    await page.reload();

    await expect(on(page).chat.locators.dictation.toggle).toHaveAttribute('data-state', 'idle');
    expect(speechModel.requests).toHaveLength(2);
  });

  test('shows the progress of the download and lets it be cancelled', async ({ on, page, speechModel }) => {
    const { dictation } = on(page).chat.locators;
    speechModel.hold();

    await on(page).chat.do.startDictationSetup();
    await expect(dictation.download).toContainText('wird heruntergeladen');
    await expect(dictation.toggle).toBeDisabled();
    await dictation.downloadCancel.click();
    speechModel.release();

    await expect(dictation.toggle).toHaveAttribute('data-state', 'not_installed');
    await expect(dictation.download).toHaveCount(0);
    await expect(dictation.error).toHaveCount(0);
  });

  test('says so when the download fails', async ({ on, page, speechModel }) => {
    const { dictation } = on(page).chat.locators;
    speechModel.corrupt('config.json');

    await on(page).chat.do.startDictationSetup();
    await expect(dictation.error).toContainText('config.json');
    await expect(dictation.toggle).toHaveAttribute('data-state', 'not_installed');
  });

  test('drops a recording that is discarded', async ({ on, page }) => {
    const { dictation, inputs } = on(page).chat.locators;
    await on(page).chat.do.startDictationSetup();
    await expect(dictation.toggle).toHaveAttribute('data-state', 'idle');

    await dictation.toggle.click();
    await expect(dictation.toggle).toHaveAttribute('data-state', 'recording');
    await dictation.discard.click();

    await expect(dictation.toggle).toHaveAttribute('data-state', 'idle');
    await expect(inputs.message).toHaveValue('');
  });

  test('grants the microphone but never the camera', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const attempt = (constraints: MediaStreamConstraints) =>
        navigator.mediaDevices.getUserMedia(constraints).then(
          (stream) => {
            stream.getTracks().forEach((track) => track.stop());
            return 'granted';
          },
          (error: DOMException) => error.name,
        );
      return { audio: await attempt({ audio: true }), video: await attempt({ video: true }), both: await attempt({ audio: true, video: true }) };
    });

    expect(outcome).toEqual({ audio: 'granted', video: 'NotAllowedError', both: 'NotAllowedError' });
  });

  test('has no serious or critical accessibility violations while recording', async ({ on, page }, testInfo) => {
    const { dictation } = on(page).chat.locators;
    await on(page).chat.do.startDictationSetup();
    await expect(dictation.toggle).toHaveAttribute('data-state', 'idle');
    await dictation.toggle.click();
    await expect(dictation.toggle).toHaveAttribute('data-state', 'recording');

    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test('dictates with the model chosen in the settings', async ({ on, page }) => {
    const { navigation, settings, chat } = on(page);
    await navigation.do.open('settings');
    await settings.locators.tabs.profile.click();
    await settings.locators.speech.model.selectOption('medium');
    await settings.locators.speech.install.click();
    await expect(settings.locators.speech.state('medium')).toHaveText('heruntergeladen');
    await navigation.do.open('chat');
    await expect(chat.locators.dictation.toggle).toHaveAttribute('data-state', 'idle');

    await chat.locators.dictation.toggle.click();
    await page.waitForTimeout(1_500);
    await chat.locators.dictation.toggle.click();

    await expect(chat.locators.inputs.message).toHaveValue(/^test-medium hörte \d+ Werte$/);
  });

  test('has no serious or critical accessibility violations in the setup dialog', async ({ on, page }, testInfo) => {
    const { dictation } = on(page).chat.locators;
    await dictation.toggle.click();
    await expect(dictation.installDialog).toBeVisible();

    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
