import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** Datei-Import (Dateiauswahl, entspricht dem Drag-and-Drop-Pfad) und die Inbox mit Klassifikationsvorschlägen. */
export function initInbox(page: Page) {
  const locators = {
    fileInput: page.getByTestId('file-input'),
    items: page.getByTestId('inbox-item'),
    proposals: page.getByTestId('inbox-proposal'),
    llmStatus: page.getByTestId('inbox-llm-status'),
    folderLocked: page.getByTestId('inbox-folder-locked'),
    buttons: {
      archive: page.getByTestId('inbox-archive'),
      reprocess: page.getByTestId('inbox-reprocess'),
    },
    reprocessDialog: {
      root: page.getByTestId('confirm-dialog'),
      allowLlm: page.getByTestId('inbox-reprocess-llm'),
      confirm: page.getByTestId('inbox-reprocess-confirm'),
    },
    archivePlan: {
      source: page.getByTestId('archive-plan-source'),
      target: page.getByTestId('archive-plan-target'),
      confirm: page.getByTestId('archive-confirm'),
      result: page.getByTestId('archive-result'),
      close: page.getByTestId('archive-close'),
    },
  };
  const interactions = {
    importFile: async (file: string) => {
      await locators.fileInput.setInputFiles(file);
    },
    /** Wartet auf den ersten Eintrag samt Vorschlag und gibt dessen Ziel zurück. */
    waitForProposal: async (target: string) => {
      await expect(locators.items.first()).toBeVisible();
      await expect(locators.proposals.first()).toContainText(target, { timeout: 30_000 });
    },
    /** „Erneut verarbeiten“ in the confirmation dialog of mode „vorher fragen“, with or without consent to the AI transfer. */
    reprocessConfirmed: async (withLlm: boolean) => {
      await locators.buttons.reprocess.first().click();
      await expect(locators.reprocessDialog.root).toBeVisible();
      if (withLlm) await locators.reprocessDialog.allowLlm.check();
      await locators.reprocessDialog.confirm.click();
      await expect(locators.reprocessDialog.root).toBeHidden();
    },
    openArchivePlan: async () => {
      await locators.buttons.archive.first().click();
    },
    confirmArchive: async () => {
      await locators.archivePlan.confirm.click();
      await expect(locators.archivePlan.result).toContainText(/erfolgreich|archiviert/i);
    },
  };
  return pageObject(locators.items, locators, interactions);
}
