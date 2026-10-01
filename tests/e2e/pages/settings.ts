import type { Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Einstellungsseite, bisher nur der Bereich „Datenschutz“. */
export function initSettings(page: Page) {
  const locators = {
    tabs: {
      privacy: page.getByTestId('tab-privacy'),
    },
    privacy: {
      mode: (mode: PrivacyMode) => page.getByTestId(`settings-mode-${mode}`),
      activeMode: page.getByTestId('privacy-mode-active'),
      extensions: page.getByTestId('privacy-exts'),
    },
  };
  const interactions = {
    openPrivacy: async () => {
      await locators.tabs.privacy.click();
    },
    selectMode: async (mode: PrivacyMode) => {
      await locators.privacy.mode(mode).check();
    },
  };
  return pageObject(page.getByRole('tablist', { name: 'Einstellungsbereiche' }), locators, interactions);
}
