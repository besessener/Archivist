import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** File import (file picker, equivalent to the drag-and-drop path) and the inbox with classification proposals. */
export function initInbox(page: Page) {
  const locators = {
    fileInput: page.getByTestId('file-input'),
    /** The import progress card bottom left; it covers what lies beneath until closed. */
    importCard: page.getByTestId('import-card'),
    /** Folder import via the folder picker (in tests ARCHIVIST_TEST_PICK_DIR names the folder). */
    folderPick: page.getByTestId('folder-pick'),
    importFolders: page.getByTestId('import-folders'),
    closeImportCard: page.getByRole('button', { name: 'Import-Hinweis schließen' }),
    items: page.getByTestId('inbox-item'),
    proposals: page.getByTestId('inbox-proposal'),
    /** What the analysis did not see of a long document. */
    coverage: page.getByTestId('document-coverage'),
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
    /** „Alle N Vorschläge archivieren“: one confirmation with the target structure, then one job (#228). */
    archiveAll: {
      open: page.getByTestId('inbox-archive-all-open'),
      preview: page.getByTestId('archive-all-preview'),
      folders: page.getByTestId('archive-all-folders'),
      confirm: page.getByTestId('archive-all-confirm'),
      progress: page.getByTestId('archive-all-progress'),
    },
    /** Paging of a long inbox. */
    paging: {
      info: page.getByTestId('inbox-more'),
      loadMore: page.getByTestId('inbox-load-more'),
    },
    /** „Alle N mit KI analysieren“ after a folder import in mode „vorher fragen“. */
    analyzeImport: {
      estimate: page.getByTestId('bulk-consent-estimate'),
      budget: page.getByTestId('bulk-consent-budget'),
      allowLlm: page.getByTestId('analyze-import-llm'),
      confirm: page.getByTestId('analyze-import-confirm'),
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
    /** Imports several files at once and closes the import card again. */
    importFiles: async (files: string[]) => {
      await locators.fileInput.setInputFiles(files);
      await locators.closeImportCard.click();
      await expect(locators.importCard).toBeHidden();
    },
    /** Waits for the first entry including its proposal and checks that the proposal shows the given target. */
    waitForProposal: async (target: string) => {
      await expect(locators.items.first()).toBeVisible();
      await expect(locators.proposals.first()).toContainText(target, { timeout: 30_000 });
    },
    /** „Erneut verarbeiten“ in the confirmation dialog of mode „vorher fragen“, with or without consent to the AI transfer. */
    reprocessConfirmed: async (consent: { allowLlm: boolean }) => {
      await locators.buttons.reprocess.first().click();
      await expect(locators.reprocessDialog.root).toBeVisible();
      if (consent.allowLlm) await locators.reprocessDialog.allowLlm.check();
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
  return pageObject({ root: locators.items, locators, actions: interactions });
}
