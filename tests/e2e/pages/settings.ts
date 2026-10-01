import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Einstellungsseite: Bereiche „Datenschutz“ und „Benachrichtigungen“. */
export function initSettings(page: Page) {
  const locators = {
    tabs: {
      privacy: page.getByTestId('tab-privacy'),
      notifications: page.getByTestId('tab-notifications'),
    },
    privacy: {
      mode: (mode: PrivacyMode) => page.getByTestId(`settings-mode-${mode}`),
      activeMode: page.getByTestId('privacy-mode-active'),
      extensions: page.getByTestId('privacy-exts'),
    },
    notifications: {
      reminderTime: page.getByTestId('settings-reminder-time'),
      saveReminderTime: page.getByTestId('settings-reminder-time-save'),
    },
  };
  const interactions = {
    openPrivacy: async () => {
      await locators.tabs.privacy.click();
    },
    selectMode: async (mode: PrivacyMode) => {
      await locators.privacy.mode(mode).check();
    },
    openNotifications: async () => {
      await locators.tabs.notifications.click();
    },
    setReminderTime: async (time: string) => {
      await locators.notifications.reminderTime.fill(time);
      await locators.notifications.saveReminderTime.click();
      await expect(locators.notifications.saveReminderTime).toBeDisabled();
    },
  };
  return pageObject(page.getByRole('tablist', { name: 'Einstellungsbereiche' }), locators, interactions);
}
