import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** The notification bell and its panel. */
export function initNotifications(page: Page) {
  const panel = page.getByTestId('bell-panel');
  const locators = {
    bell: page.getByTestId('bell'),
    panel,
    items: panel.getByTestId('bell-item'),
    markAllRead: panel.getByTestId('bell-mark-all-read'),
    clearAll: panel.getByTestId('bell-clear-all'),
    count: page.getByTestId('bell-count'),
    actions: {
      navigate: panel.getByTestId('bell-action-navigate'),
      dismiss: panel.getByTestId('bell-action-ignore'),
      confirm: panel.getByTestId('bell-action-confirm_action'),
    },
    actionDialog: page.getByTestId('notification-action-dialog'),
  };
  const item = (text: string) => locators.items.filter({ hasText: text });
  const interactions = {
    open: async () => {
      await locators.bell.click();
      await expect(panel).toBeVisible();
    },
    /** Closes the panel so that it does not cover the page behind it. */
    close: async () => {
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    },
  };
  return Object.assign(pageObject({ root: panel, locators, actions: interactions }), { item });
}
