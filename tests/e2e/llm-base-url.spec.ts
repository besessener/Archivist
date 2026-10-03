import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('base URL of the LLM endpoint (#209)', () => {
  test('the settings explain why clear text to a remote host is refused and accept https and localhost', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openLlm();
    const { baseUrl, baseUrlError, save, testConnection } = app.settings.locators.llm;

    await baseUrl.fill('http://llm.example.test/v1');

    await expect(baseUrlError).toContainText('Verwende https://');
    await expect(baseUrl).toHaveAttribute('aria-invalid', 'true');
    await expect(baseUrl).toHaveAttribute('aria-describedby', 's-baseurl-error');
    await expect(save).toBeDisabled();
    await expect(testConnection).toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);

    await baseUrl.fill('https://llm.example.test/v1');
    await expect(baseUrlError).toHaveCount(0);
    await expect(baseUrl).not.toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeEnabled();

    await baseUrl.fill('http://localhost:11434/v1');
    await expect(baseUrlError).toHaveCount(0);
    await expect(save).toBeEnabled();
  });

  test('the setup wizard does not continue with a clear-text remote address', async ({ on, page }) => {
    const { setup } = on(page);
    await setup.locators.buttons.next.click();

    await setup.locators.inputs.baseUrl.fill('http://llm.example.test/v1');

    await expect(setup.locators.texts.baseUrlError).toContainText('Verwende https://');
    await expect(setup.locators.inputs.baseUrl).toHaveAttribute('aria-invalid', 'true');
    await expect(setup.locators.buttons.testConnection).toBeDisabled();
    await expect(setup.locators.buttons.next).toBeDisabled();

    await setup.locators.inputs.baseUrl.fill('https://llm.example.test/v1');
    await expect(setup.locators.texts.baseUrlError).toHaveCount(0);
    await expect(setup.locators.buttons.next).toBeEnabled();
  });
});
