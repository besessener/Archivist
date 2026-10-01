import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** Datei-Import (Dateiauswahl, entspricht dem Drag-and-Drop-Pfad) und die Inbox mit Klassifikationsvorschlägen. */
export function initInbox(page: Page) {
  const locators = {
    fileInput: page.getByTestId('file-input'),
    items: page.getByTestId('inbox-item'),
    proposals: page.getByTestId('inbox-proposal'),
    llmStatus: page.getByTestId('inbox-llm-status'),
    fields: {
      topic: page.getByTestId('inbox-topic'),
      project: page.getByTestId('inbox-project'),
    },
    buttons: {
      archive: page.getByTestId('inbox-archive'),
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
