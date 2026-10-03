import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initScan(page: Page) {
  const locators = {
    buttons: {
      enable: page.getByTestId('scan-enable'),
      addDirectory: page.getByTestId('scan-add-dir'),
      start: page.getByTestId('scan-start'),
      analyze: page.getByTestId('scan-analyze'),
      confirmAnalysis: page.getByTestId('scan-analyze-confirm'),
    },
    directories: page.getByTestId('scan-dir'),
    fileRows: page.getByTestId('scan-file-row'),
    summary: page.getByTestId('scan-summary'),
    allowLlm: page.getByTestId('scan-llm-checkbox'),
    proposals: page.getByTestId('scan-proposal'),
  };
  const fileRow = (name: string) => locators.fileRows.filter({ hasText: name });
  const interactions = {
    /** Allows a directory (in tests the picker dialog is replaced by ARCHIVIST_TEST_PICK_DIR). */
    allowDirectory: async (name: string) => {
      await locators.buttons.enable.click();
      await locators.buttons.addDirectory.click();
      await expect(locators.directories.first()).toContainText(name);
    },
    scan: async () => {
      await locators.buttons.start.click();
    },
    /** Analyses a file with explicit LLM permission. */
    analyzeWithLlm: async (name: string) => {
      await fileRow(name).getByTestId('scan-file-checkbox').check();
      await locators.buttons.analyze.click();
      await locators.allowLlm.check();
      await locators.buttons.confirmAnalysis.click();
    },
  };
  return Object.assign(pageObject({ root: locators.fileRows, locators, actions: interactions }), { fileRow });
}
