import path from 'node:path';
import { docDay } from '../common';
import { csvNumber, type ExportItem } from './items';

export const CSV_COLUMNS = ['datum', 'titel', 'typ', 'absender', 'betrag', 'ordner', 'thema', 'projekt', 'datei'] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

const CSV_HEADER: Record<CsvColumn, string> = {
  datum: 'Datum',
  titel: 'Titel',
  typ: 'Typ',
  absender: 'Absender',
  betrag: 'Betrag',
  ordner: 'Ordner',
  thema: 'Thema',
  projekt: 'Projekt',
  datei: 'Datei',
};

export const csvCell = (value: string) => (/[";\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

const CSV_VALUE: Record<CsvColumn, (item: ExportItem) => string> = {
  datum: (item) => docDay(item.doc),
  titel: (item) => item.doc.title,
  typ: (item) => item.doc.docType ?? '',
  absender: (item) => item.doc.persons.slice(0, 3).join(', '),
  betrag: (item) => (item.amount === null ? '' : csvNumber(item.amount)),
  ordner: (item) => item.folder,
  thema: (item) => item.doc.topicName ?? '',
  projekt: (item) => item.doc.projectName ?? '',
  datei: (item) => (item.doc.archiveRelPath ? path.posix.basename(item.doc.archiveRelPath) : item.doc.originalName),
};

const BOM = String.fromCodePoint(0xfeff);

/** Semicolon separated, UTF-8 with BOM, CRLF – opens directly in Excel. */
export function toCsv(items: ExportItem[], columns: readonly CsvColumn[]): string {
  const lines = [columns.map((c) => csvCell(CSV_HEADER[c])).join(';'), ...items.map((i) => columns.map((c) => csvCell(CSV_VALUE[c](i))).join(';'))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
