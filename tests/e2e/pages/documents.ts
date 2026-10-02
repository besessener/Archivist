import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** The first column is the selection checkbox (no heading). */
const COLUMNS = ['Auswahl', 'Titel', 'Typ', 'Kategorie', 'Thema', 'Projekt', 'Datum', 'Pfad'] as const;

/** The document list with topic and project columns. */
export function initDocuments(page: Page) {
  const table = page.getByTestId('documents-table');
  const locators = {
    rows: page.getByTestId('document-row'),
    /** Cell of a row by column heading. */
    cell: (row: number, column: (typeof COLUMNS)[number]) => page.getByTestId('document-row').nth(row).getByRole('cell').nth(COLUMNS.indexOf(column)),
    /** Multi-selection with its bulk actions (#291, #304). */
    bulk: {
      selectAll: page.getByTestId('documents-select-all'),
      rename: page.getByTestId('bulk-rename'),
      result: page.getByTestId('bulk-result'),
    },
    renameDialog: {
      root: page.getByTestId('bulk-rename-dialog'),
      pattern: page.getByTestId('bulk-rename-pattern'),
      previewButton: page.getByTestId('bulk-rename-preview-button'),
      preview: page.getByTestId('bulk-rename-preview'),
      save: page.getByTestId('bulk-rename-save'),
    },
  };
  const interactions = {
    /** Renames all listed documents by a scheme: preview first, then rename. */
    renameAll: async (pattern: string, expectedName: string) => {
      await locators.bulk.selectAll.click();
      await locators.bulk.rename.click();
      await locators.renameDialog.pattern.fill(pattern);
      await locators.renameDialog.previewButton.click();
      await expect(locators.renameDialog.preview).toContainText(expectedName);
      await locators.renameDialog.save.click();
      await expect(locators.bulk.result).toContainText('Umbenennen abgeschlossen');
    },
  };
  return pageObject(table, locators, interactions);
}
