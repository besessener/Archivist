import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Einrichtungsdialog beim ersten Start. */
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
      testResult: root.getByTestId('setup-test-result'),
    },
  };
  const interactions = {
    /** Trägt den LLM-Endpunkt ein und prüft die Verbindung. */
    connectLlm: async (baseUrl: string, apiKey = 'sk-e2e-SECRET-0123456789', model = 'e2e-model') => {
      await locators.buttons.next.click();
      await locators.inputs.baseUrl.fill(baseUrl);
      await locators.inputs.apiKey.fill(apiKey);
      await locators.inputs.model.fill(model);
      await locators.buttons.testConnection.click();
      await expect(locators.texts.testResult).toContainText('erfolgreich');
    },
    /** Von der Verbindungsprüfung bis zum Abschluss; Verzeichnisse werden übersprungen, Modus: automatisch (Standard). */
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
  return pageObject(root, locators, interactions);
}
