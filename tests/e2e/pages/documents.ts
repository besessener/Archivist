import type { Page } from '@playwright/test';
import { pageObject } from './page-object';

const COLUMNS = ['Titel', 'Typ', 'Kategorie', 'Thema', 'Projekt', 'Datum', 'Pfad'] as const;

/** Die Dokumentenliste mit Thema- und Projektspalte. */
export function initDocuments(page: Page) {
  const table = page.getByTestId('documents-table');
  const locators = {
    rows: page.getByTestId('document-row'),
    /** Zelle einer Zeile nach Spaltenüberschrift. */
    cell: (row: number, column: (typeof COLUMNS)[number]) => page.getByTestId('document-row').nth(row).getByRole('cell').nth(COLUMNS.indexOf(column)),
  };
  return pageObject(table, locators, {});
}
