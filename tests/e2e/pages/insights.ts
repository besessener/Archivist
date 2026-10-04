import { expect, type Locator, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** Insights page: archive check, insight cards and answers to question insights. */
export function initInsights(page: Page) {
  const locators = {
    cards: page.getByTestId('insight-card'),
    statusFilter: page.getByTestId('insight-status-filter'),
    /** „N von M“ note with „Mehr laden“ while the list holds only the newest insights (#223). */
    capped: page.getByTestId('insights-capped'),
    loadMore: page.getByTestId('insights-load-more'),
    /** Contradictions below the insights, paged the same way. */
    contradictions: {
      cards: page.getByTestId('contradiction-card'),
      capped: page.getByTestId('contradictions-capped'),
      loadMore: page.getByTestId('contradictions-load-more'),
    },
    buttons: {
      runCheck: page.getByTestId('consistency-run'),
    },
    choiceDialog: {
      checkbox: page.getByTestId('confirm-dialog-checkbox'),
      confirm: page.getByTestId('insight-choice-confirm'),
    },
  };
  const card = (title: string) => locators.cards.filter({ hasText: title });
  const choices = (insightCard: Locator) => insightCard.getByTestId('insight-choice');
  const interactions = {
    runCheck: async () => {
      await locators.buttons.runCheck.click();
    },
    /** Answers a question insight; an answer that changes data is confirmed in the dialog. */
    choose: async (insightCard: Locator, answer: { label: string; confirm: boolean }) => {
      await choices(insightCard).filter({ hasText: answer.label }).click();
      if (answer.confirm) {
        await locators.choiceDialog.checkbox.click();
        await locators.choiceDialog.confirm.click();
      }
      await expect(insightCard).toBeHidden();
    },
    showStatus: async (status: 'open' | 'accepted' | 'rejected' | 'snoozed') => {
      await locators.statusFilter.selectOption(status);
    },
  };
  return Object.assign(pageObject({ root: locators.cards, locators, actions: interactions }), { card, choices });
}
