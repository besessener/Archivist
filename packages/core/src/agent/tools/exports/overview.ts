import { docDay } from '../common';
import { toCsv } from './csv';
import { csvNumber, formatAmount, monthGaps, sumOf, withAmount, type ExportItem } from './items';
import type { PdfLine } from './pdf';

/** The overview page of a bundle. */
export interface Overview {
  title: string;
  /** YYYY-MM-DD the bundle is created on */
  created: string;
  items: ExportItem[];
  /** per document: note in the overview (e.g. „nicht eingebunden (kein PDF)“) */
  notes: Map<string, string>;
}

const markdownCell = (text: string) => text.replace(/\s+/g, ' ').replaceAll('|', '\\|');
const byDay = (items: ExportItem[]) => items.toSorted((a, b) => docDay(a.doc).localeCompare(docDay(b.doc)));
const gapsOf = (items: ExportItem[]) => monthGaps(items.map((i) => docDay(i.doc)));
const NO_GAPS = 'Keine Monate ohne Dokument zwischen dem ersten und dem letzten Dokument.';

const sumText = (items: ExportItem[], bold: string) =>
  withAmount(items)
    ? `${bold}Summe: ${formatAmount(sumOf(items))}${bold} (aus ${withAmount(items)} Dokument(en) mit erkanntem Betrag)`
    : 'Kein Betrag erkannt.';

function markdownRow(overview: Overview, item: ExportItem): string {
  const note = overview.notes.get(item.doc.id);
  const cells = [
    docDay(item.doc),
    item.doc.title,
    item.doc.docType ?? '',
    item.folder,
    item.amount === null ? '' : formatAmount(item.amount),
    `${item.doc.originalName}${overview.notes.has(item.doc.id) ? ` – ${note}` : ''}`,
  ];
  return `| ${cells.map(markdownCell).join(' | ')} |`;
}

export function overviewMarkdown(overview: Overview): string {
  const gaps = gapsOf(overview.items);
  const lines = [
    `# ${overview.title}`,
    '',
    `Erstellt am ${overview.created} · ${overview.items.length} Dokument(e)`,
    '',
    '| Datum | Titel | Typ | Ordner | Betrag | Datei |',
    '| --- | --- | --- | --- | ---: | --- |',
    ...byDay(overview.items).map((i) => markdownRow(overview, i)),
    '',
    sumText(overview.items, '**'),
    '',
    '## Lücken',
    '',
    gaps.length ? `Monate ohne Dokument: ${gaps.join(', ')}` : NO_GAPS,
  ];
  return `${lines.join('\n')}\n`;
}

export function overviewCsv(overview: Overview): string {
  const rows = toCsv(byDay(overview.items), ['datum', 'titel', 'typ', 'ordner', 'betrag', 'datei']);
  return withAmount(overview.items) ? `${rows};Summe;;;${csvNumber(sumOf(overview.items))};\r\n` : rows;
}

export function overviewPdfLines(overview: Overview): PdfLine[] {
  const gaps = gapsOf(overview.items);
  return [
    { text: overview.title, size: 18, bold: true },
    { text: `Erstellt am ${overview.created} · ${overview.items.length} Dokument(e)`, gap: 4 },
    { text: 'Dokumente', size: 13, bold: true, gap: 12 },
    ...byDay(overview.items).map((i, n) => ({
      text: [
        `${n + 1}. ${docDay(i.doc)} – ${i.doc.title}`,
        i.doc.docType,
        `Ordner: ${i.folder}`,
        i.amount === null ? null : formatAmount(i.amount),
        overview.notes.get(i.doc.id) ?? null,
      ]
        .filter(Boolean)
        .join(' | '),
      gap: 3,
    })),
    { text: sumText(overview.items, ''), bold: true, gap: 12 },
    { text: 'Lücken', size: 13, bold: true, gap: 12 },
    { text: gaps.length ? `Monate ohne Dokument: ${gaps.join(', ')}` : NO_GAPS, gap: 3 },
  ];
}
