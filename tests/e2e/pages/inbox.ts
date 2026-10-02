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
    fields: {
      topic: page.getByTestId('inbox-topic'),
      project: page.getByTestId('inbox-project'),
    },
    buttons: {
      archive: page.getByTestId('inbox-archive'),
      reprocess: page.getByTestId('inbox-reprocess'),
    },
    reprocessDialog: {
      root: page.getByTestId('confirm-dialog'),
      allowLlm: page.getByTestId('inbox-reprocess-llm'),
      confirm: page.getByTestId('inbox-reprocess-confirm'),
    },
    quarantine: {
      filter: page.getByTestId('inbox-filter-quarantined'),
      badge: page.getByTestId('inbox-quarantine-badge'),
      reason: page.getByTestId('inbox-error'),
      reveal: page.getByTestId('inbox-quarantine-reveal'),
      release: page.getByTestId('inbox-quarantine-release'),
      confirmCheckbox: page.getByTestId('confirm-dialog-checkbox'),
      confirm: page.getByTestId('inbox-quarantine-release-confirm'),
    },
    archivePlan: {
      source: page.getByTestId('archive-plan-source'),
      target: page.getByTestId('archive-plan-target'),
      confirm: page.getByTestId('archive-confirm'),
      removesSource: page.getByTestId('archive-plan-removes-source'),
      inboxCopy: page.getByTestId('archive-plan-inbox-copy'),
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
    /** "Trotzdem importieren" for the first quarantined entry, including the confirmation dialog. */
    releaseFromQuarantine: async () => {
      await locators.quarantine.release.first().click();
      await expect(locators.quarantine.confirm).toBeDisabled();
      await locators.quarantine.confirmCheckbox.click();
      await locators.quarantine.confirm.click();
    },
    confirmArchive: async () => {
      await locators.archivePlan.confirm.click();
      await expect(locators.archivePlan.result).toContainText(/erfolgreich|archiviert/i);
    },
  };
  return pageObject(locators.items, locators, interactions);
}
