import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

/** The first column is the selection checkbox (no heading). */
const COLUMNS = ['Auswahl', 'Titel', 'Typ', 'Kategorie', 'Thema', 'Projekt', 'Datum', 'Pfad'] as const;

/** The document list with topic and project columns. */
export function initDocuments(page: Page) {
  const table = page.getByTestId('documents-table');
  const locators = {
    rows: page.getByTestId('document-row'),
    typeFilter: page.getByTestId('documents-type-filter'),
    /** „N von M“ note with „Mehr laden“ while the list holds only the newest documents (#222). */
    capped: page.getByTestId('documents-capped'),
    loadMore: page.getByTestId('documents-load-more'),
    /** Cell of a row by column heading. */
    cell: (row: number, column: (typeof COLUMNS)[number]) => page.getByTestId('document-row').nth(row).getByRole('cell').nth(COLUMNS.indexOf(column)),
    /** Multi-selection with its bulk actions (#291, #304). */
    bulk: {
      selectAll: page.getByTestId('documents-select-all'),
      rename: page.getByTestId('bulk-rename'),
      result: page.getByTestId('bulk-result'),
    },
    /** The detail dialog of a document, with „In den Papierkorb“. */
    dialog: {
      root: page.getByTestId('document-dialog'),
      trash: page.getByTestId('doc-trash'),
      confirmTrash: page.getByTestId('doc-trash-confirm'),
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
    /** Opens the detail dialog of a row by its title. */
    open: async (row: number) => {
      await locators.cell(row, 'Titel').getByRole('button').click();
      await locators.dialog.root.waitFor();
    },
    /** Moves the document of a row into the trash, after the confirmation. */
    moveToTrash: async (row: number) => {
      await interactions.open(row);
      await locators.dialog.trash.click();
      await locators.dialog.confirmTrash.click();
      await expect(locators.dialog.root).toBeHidden();
    },
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
  return pageObject({ root: table, locators, actions: interactions });
}
