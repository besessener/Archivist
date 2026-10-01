import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initSettings(page: Page) {
  const locators = {
    tabs: {
      notifications: page.getByTestId('tab-notifications'),
    },
    inputs: {
      reminderTime: page.getByTestId('settings-reminder-time'),
    },
    buttons: {
      saveReminderTime: page.getByTestId('settings-reminder-time-save'),
    },
  };
  const interactions = {
    setReminderTime: async (time: string) => {
      await locators.tabs.notifications.click();
      await locators.inputs.reminderTime.fill(time);
      await locators.buttons.saveReminderTime.click();
      await expect(locators.buttons.saveReminderTime).toBeDisabled();
    },
  };
  return pageObject(locators.tabs.notifications, locators, interactions);
}
