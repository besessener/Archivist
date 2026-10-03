import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Setup wizard on first launch. */
export function initSetupWizard(page: Page) {
  const root = page.getByTestId('setup-wizard');
  const locators = {
    buttons: {
      next: root.getByTestId('setup-next'),
      testConnection: root.getByTestId('setup-test'),
      finish: root.getByTestId('setup-finish'),
    },
    inputs: {
      baseUrl: root.getByTestId('setup-baseurl'),
      apiKey: root.getByTestId('setup-apikey'),
      model: root.getByTestId('setup-model'),
      profileName: root.getByTestId('setup-profile-name'),
      mode: (mode: PrivacyMode) => root.getByTestId(`setup-mode-${mode}`),
    },
    texts: {
      baseUrlError: root.getByTestId('setup-baseurl-error'),
      testResult: root.getByTestId('setup-test-result'),
      syncWarning: root.getByTestId('setup-sync-warning'),
    },
  };
  const interactions = {
    /** Enters the LLM endpoint and tests the connection. */
    connectLlm: async (baseUrl: string) => {
      await locators.buttons.next.click();
      await locators.inputs.baseUrl.fill(baseUrl);
      await locators.inputs.apiKey.fill('sk-e2e-SECRET-0123456789');
      await locators.inputs.model.fill('e2e-model');
      await locators.buttons.testConnection.click();
      await expect(locators.texts.testResult).toContainText('erfolgreich');
    },
    /** From the connection test to the end; directories are skipped, mode: automatic (default). */
    finish: async (mode: PrivacyMode = 'auto') => {
      await locators.buttons.next.click();
      await locators.buttons.next.click();
      await locators.inputs.mode(mode).check();
      await locators.buttons.next.click();
      await locators.buttons.finish.click();
      await expect(page.getByTestId('chat-page')).toBeVisible();
    },
    complete: async (baseUrl: string, mode: PrivacyMode = 'auto') => {
      await interactions.connectLlm(baseUrl);
      await interactions.finish(mode);
    },
  };
  return pageObject({ root, locators, actions: interactions });
}
