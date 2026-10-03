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
      delete: page.getByTestId('decision-delete'),
      confirmDelete: page.getByTestId('decision-delete-confirm'),
    },
    tabs: {
      details: page.getByTestId('decision-tab-details'),
      history: page.getByTestId('decision-tab-history'),
    },
    hints: {
      root: page.getByTestId('decision-hints'),
      contradiction: page.getByTestId('decision-hint-contradiction'),
      superseded: page.getByTestId('decision-hint-superseded'),
    },
    history: {
      entries: page.getByTestId('decision-history-entry'),
    },
    successor: page.getByTestId('decision-successor'),
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
    /** Records an incomplete decision (only its text) as a draft. */
    createDraft: async (text: string) => {
      await locators.buttons.create.click();
      await locators.inputs.text.fill(text);
      await locators.buttons.save.click();
      await expect(form).toBeHidden();
      await expect(row(text)).toBeVisible();
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
