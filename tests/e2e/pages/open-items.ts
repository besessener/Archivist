import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initOpenItems(page: Page) {
  const form = page.getByTestId('open-item-form');
  const bellPanel = page.getByTestId('bell-panel');
  const locators = {
    buttons: {
      create: page.getByTestId('open-item-new'),
      save: page.getByTestId('open-item-save'),
      bell: page.getByTestId('bell'),
    },
    form,
    inputs: {
      title: page.getByTestId('open-item-title'),
    },
    rows: page.getByTestId('open-item-row'),
    reminderDialog: page.getByTestId('reminder-dialog'),
    /** „Anstehende Erinnerungen“ on the open-items page itself. */
    upcoming: page.getByRole('main').getByTestId('upcoming-reminders'),
    bellPanel,
    /** „Anstehende Erinnerungen“ inside the notification bell. */
    bellUpcoming: bellPanel.getByTestId('upcoming-reminders'),
  };
  const row = (title: string) => locators.rows.filter({ hasText: title });
  const interactions = {
    create: async (title: string) => {
      await locators.buttons.create.click();
      await locators.inputs.title.fill(title);
      await locators.buttons.save.click();
      await expect(form).toBeHidden();
      await expect(row(title)).toBeVisible();
    },
    /** Sets the reminder of an open item to tomorrow via its „Erinnern“ dialog. */
    remindTomorrow: async (title: string) => {
      await row(title).getByTestId('open-item-remind').click();
      await locators.reminderDialog.getByTestId('quick-tomorrow').click();
      await expect(locators.reminderDialog).toBeHidden();
    },
  };
  return Object.assign(pageObject({ root: locators.rows, locators, actions: interactions }), { row });
}
