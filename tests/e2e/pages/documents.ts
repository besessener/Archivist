import type { Page } from '@playwright/test';
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
  };
  return pageObject(table, locators, {});
}
