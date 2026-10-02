import { expect, type Locator, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** Insights page: archive check, insight cards and answers to question insights. */
export function initInsights(page: Page) {
  const locators = {
    cards: page.getByTestId('insight-card'),
    statusFilter: page.getByTestId('insight-status-filter'),
    buttons: {
      runCheck: page.getByTestId('consistency-run'),
    },
    choiceDialog: {
      checkbox: page.getByTestId('confirm-dialog-checkbox'),
      confirm: page.getByTestId('insight-choice-confirm'),
    },
  };
  const card = (title: string) => locators.cards.filter({ hasText: title });
  const choices = (c: Locator) => c.getByTestId('insight-choice');
  const interactions = {
    runCheck: async () => {
      await locators.buttons.runCheck.click();
    },
    /** Answers a question insight; an answer that changes data is confirmed in the dialog. */
    choose: async (c: Locator, label: string, opts: { confirm: boolean }) => {
      await choices(c).filter({ hasText: label }).click();
      if (opts.confirm) {
        await locators.choiceDialog.checkbox.click();
        await locators.choiceDialog.confirm.click();
      }
      await expect(c).toBeHidden();
    },
    showStatus: async (status: 'open' | 'accepted' | 'rejected' | 'snoozed') => {
      await locators.statusFilter.selectOption(status);
    },
  };
  return Object.assign(pageObject(locators.cards, locators, interactions), { card, choices });
}
