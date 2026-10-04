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
      loadMore: page.getByTestId('scan-load-more'),
    },
    directories: page.getByTestId('scan-dir'),
    fileRows: page.getByTestId('scan-file-row'),
    analyzedRows: page.locator('[data-testid="scan-file-row"][data-status="analyzed"]'),
    summary: page.getByTestId('scan-summary'),
    resultsCount: page.getByTestId('scan-results-count'),
    allowLlm: page.getByTestId('scan-llm-checkbox'),
    proposals: page.getByTestId('scan-proposal'),
    /** Paging over all results and „erneut analysieren“. */
    paging: {
      info: page.getByTestId('scan-more'),
      loadMore: page.getByTestId('scan-load-more'),
    },
    reanalyze: page.getByTestId('scan-reanalyze'),
    /** „Alle N neuen Dateien analysieren“: one consent, one job with a progress line (#228). */
    analyzeAll: {
      button: page.getByTestId('scan-analyze-all'),
      estimate: page.getByTestId('bulk-consent-estimate'),
      allowLlm: page.getByTestId('scan-analyze-all-llm'),
      confirm: page.getByTestId('scan-analyze-all-confirm'),
      progress: page.getByTestId('scan-analyze-all-progress'),
    },
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
    /** Opens the consent dialog of „Alle neuen Dateien analysieren“. */
    openAnalyzeAll: async () => {
      await locators.analyzeAll.button.click();
      await expect(locators.analyzeAll.estimate).toBeVisible();
    },
  };
  return Object.assign(pageObject({ root: locators.fileRows, locators, actions: interactions }), { fileRow });
}
