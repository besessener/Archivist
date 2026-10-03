import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initDecisions(page: Page) {
  const form = page.getByTestId('decision-form');
  const locators = {
    buttons: {
      create: page.getByTestId('decision-new'),
      edit: page.getByTestId('decision-edit'),
      save: page.getByTestId('decision-save'),
      confirmStatus: page.getByTestId('decision-status-confirm'),
    },
    form,
    inputs: {
      text: page.getByTestId('decision-text'),
      date: page.getByTestId('decision-date'),
      topic: page.getByTestId('decision-topic'),
      participants: page.getByTestId('decision-participants'),
      status: page.getByTestId('decision-status'),
      supersededBy: page.getByTestId('decision-superseded-by'),
    },
    confirmDialog: page.getByTestId('confirm-dialog'),
    rows: page.getByTestId('decision-row'),
    /** „Vorgeschlagene Entscheidungen“: the page of decisions found in documents, reached from the decisions page. */
    proposed: {
      open: page.getByTestId('decisions-proposed'),
      back: page.getByTestId('proposed-decisions-back'),
      cards: page.getByTestId('proposed-decision'),
      more: page.getByTestId('proposed-decisions-more'),
    },
    detail: page.getByTestId('decision-detail'),
  };
  const row = (text: string) => locators.rows.filter({ hasText: text });
  const interactions = {
    /** Records a complete decision via the form and waits until it is listed. */
    create: async (decision: { text: string; isoDate: string; topic: string; participants: string }) => {
      await locators.buttons.create.click();
      await locators.inputs.text.fill(decision.text);
      await locators.inputs.date.fill(decision.isoDate);
      await locators.inputs.topic.fill(decision.topic);
      await locators.inputs.participants.fill(decision.participants);
      await locators.buttons.save.click();
      await expect(form).toBeHidden();
      await expect(row(decision.text)).toBeVisible();
    },
    /** Confirms the proposed decision whose card shows the text. */
    confirmProposed: async (text: string) => {
      const card = locators.proposed.cards.filter({ hasText: text });
      await card.getByTestId('action-approve').click();
      await expect(locators.proposed.cards.filter({ hasText: text })).toHaveCount(0);
    },
    /** Picks the newer decision in the „Ersetzt durch“ select by (part of) its text. */
    pickSupersededBy: async (text: string) => {
      const option = locators.inputs.supersededBy.locator('option', { hasText: text });
      await expect(option).toHaveCount(1);
      await locators.inputs.supersededBy.selectOption((await option.getAttribute('value')) ?? '');
    },
  };
  return Object.assign(pageObject({ root: locators.detail, locators, actions: interactions }), { row });
}
