import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import type { DocumentRecord } from '@archivist/shared';
import { folderLabel, folderOf } from '../../services/archive-structure';
import { assertRealInside, sanitizeFileName, uniquePath } from '../../util/paths';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import { docDay, docLine, resolveDocs, unknownNote, type ToolDeps } from './common';

/**
 * Producing results (#311): bundles, CSV lists, reports and reply drafts. Everything is written as a new file into the
 * export folder of the data directory; the archive itself stays unchanged. The model only gets privacy-filtered lines.
 */

// ---------- amounts ----------
const AMOUNT_RE = /(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?!\d)\s*(?:€|EUR\b)?/g;
const TOTAL_RE = /\b(?:gesamt\w*|\w*summe|total|endbetrag)\b/i;
const AMOUNT_LINE_RE = /\b\w*betrag\w*\b/i;

const amountsOf = (line: string): number[] =>
  [...line.matchAll(AMOUNT_RE)].map((m) => Number(`${m[1]!.replaceAll('.', '')}.${m[2]}`)).filter((n) => Number.isFinite(n));

/** Simple amount parser: last amount on the last line with Gesamt/Summe/Total, else on the last line with „Betrag“. */
export function parseAmount(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (const re of [TOTAL_RE, AMOUNT_LINE_RE]) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (!re.test(line)) continue;
      const found = amountsOf(line);
      if (found.length) return found.at(-1)!;
    }
  }
  return null;
}

const euro = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const csvNumber = (n: number) => n.toFixed(2).replace('.', ',');

/** Months (YYYY-MM) between the first and the last date without any document. */
export function monthGaps(days: string[]): string[] {
  const months = new Set(days.filter((d) => /^\d{4}-\d{2}/.test(d)).map((d) => d.slice(0, 7)));
  if (months.size < 2) return [];
  const sorted = [...months].toSorted();
  const gaps: string[] = [];
  const index = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const last = index(sorted.at(-1)!);
  for (let i = index(sorted[0]!) + 1; i < last; i += 1) {
    const key = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    if (!months.has(key)) gaps.push(key);
  }
  return gaps;
}

// ---------- files ----------
const today = () => new Date().toISOString().slice(0, 10);

async function exportPath(deps: ToolDeps, title: string, ext: string): Promise<string> {
  const dir = path.join(deps.paths.root, 'exports');
  await fsp.mkdir(dir, { recursive: true });
  // a symlinked export folder must not lead out of the data folder (#301)
  await assertRealInside(deps.paths.root, dir);
  return uniquePath(dir, sanitizeFileName(`${title.trim() || 'Export'} ${today()}.${ext}`, 'Export'));
}

async function writeExport(deps: ToolDeps, ctx: ToolContext, title: string, ext: string, data: string | Uint8Array): Promise<string> {
  const file = await exportPath(deps, title, ext);
  await fsp.writeFile(file, data, { flag: 'wx' });
  ctx.files.push(file);
  return file;
}

interface Item {
  doc: DocumentRecord;
  file: string | null;
  amount: number | null;
  folder: string;
}

function collect(deps: ToolDeps, docs: DocumentRecord[]): Item[] {
  return docs.map((doc) => {
    const row = deps.docs.findRow(doc.id);
    let file: string | null = doc.archivePath && fs.existsSync(doc.archivePath) ? doc.archivePath : null;
    if (!file && row) {
      try {
        file = deps.docs.readablePath(row);
      } catch {
        file = null;
      }
    }
    return { doc, file, amount: row ? parseAmount(row.extractedText) : null, folder: doc.archiveRelPath ? folderLabel(folderOf(doc)) : '–' };
  });
}

const sumOf = (items: Item[]) => Math.round(items.reduce((s, i) => s + (i.amount ?? 0) * 100, 0)) / 100;
const withAmount = (items: Item[]) => items.filter((i) => i.amount !== null).length;

// ---------- CSV ----------
const CSV_COLUMNS = ['datum', 'titel', 'typ', 'absender', 'betrag', 'ordner', 'thema', 'projekt', 'datei'] as const;
type CsvColumn = (typeof CSV_COLUMNS)[number];
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

export const csvCell = (v: string) => (/[";\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

function csvValue(item: Item, col: CsvColumn): string {
  const d = item.doc;
  switch (col) {
    case 'datum':
      return docDay(d);
    case 'titel':
      return d.title;
    case 'typ':
      return d.docType ?? '';
    case 'absender':
      return d.persons.slice(0, 3).join(', ');
    case 'betrag':
      return item.amount === null ? '' : csvNumber(item.amount);
    case 'ordner':
      return item.folder;
    case 'thema':
      return d.topicName ?? '';
    case 'projekt':
      return d.projectName ?? '';
    case 'datei':
      return d.archiveRelPath ? path.posix.basename(d.archiveRelPath) : d.originalName;
  }
}

const BOM = String.fromCodePoint(0xfeff);

/** Semicolon separated, UTF-8 with BOM, CRLF – opens directly in Excel. */
function toCsv(items: Item[], columns: readonly CsvColumn[]): string {
  const lines = [columns.map((c) => csvCell(CSV_HEADER[c])).join(';'), ...items.map((i) => columns.map((c) => csvCell(csvValue(i, c))).join(';'))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

// ---------- overview ----------
interface Overview {
  title: string;
  items: Item[];
  /** per document: note in the overview (e.g. „nicht eingebunden (kein PDF)“) */
  notes: Map<string, string>;
}

const mdCell = (s: string) => s.replace(/\s+/g, ' ').replaceAll('|', '\\|');

function overviewMarkdown(o: Overview): string {
  const gaps = monthGaps(o.items.map((i) => docDay(i.doc)));
  const sorted = o.items.toSorted((a, b) => docDay(a.doc).localeCompare(docDay(b.doc)));
  const out = [
    `# ${o.title}`,
    '',
    `Erstellt am ${today()} · ${o.items.length} Dokument(e)`,
    '',
    '| Datum | Titel | Typ | Ordner | Betrag | Datei |',
    '| --- | --- | --- | --- | ---: | --- |',
    ...sorted
      .map((i) =>
        [
          docDay(i.doc),
          i.doc.title,
          i.doc.docType ?? '',
          i.folder,
          i.amount === null ? '' : euro(i.amount),
          `${i.doc.originalName}${o.notes.has(i.doc.id) ? ` – ${o.notes.get(i.doc.id)}` : ''}`,
        ]
          .map(mdCell)
          .join(' | '),
      )
      .map((l) => `| ${l} |`),
    '',
    withAmount(o.items) ? `**Summe: ${euro(sumOf(o.items))}** (aus ${withAmount(o.items)} Dokument(en) mit erkanntem Betrag)` : 'Kein Betrag erkannt.',
    '',
    '## Lücken',
    '',
    gaps.length ? `Monate ohne Dokument: ${gaps.join(', ')}` : 'Keine Monate ohne Dokument zwischen dem ersten und dem letzten Dokument.',
  ];
  return `${out.join('\n')}\n`;
}

function overviewCsv(o: Overview): string {
  const rows = toCsv(
    o.items.toSorted((a, b) => docDay(a.doc).localeCompare(docDay(b.doc))),
    ['datum', 'titel', 'typ', 'ordner', 'betrag', 'datei'],
  );
  return withAmount(o.items) ? `${rows};Summe;;;${csvNumber(sumOf(o.items))};\r\n` : rows;
}

// ---------- PDF text rendering ----------
interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** extra space before the line */
  gap?: number;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;

/** Replaces characters the standard font cannot encode (WinAnsi) with '?'. */
function encodable(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text.replaceAll('\t', '    ')].map((ch) => (set.has(ch.codePointAt(0)!) ? ch : '?')).join('');
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = text.split(/ +/);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    // a single word longer than the line is cut hard
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let n = rest.length - 1;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n -= 1;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  out.push(line);
  return out;
}

/** Draws text lines onto new pages (wrapped, with page breaks); returns the number of pages added. */
async function drawText(pdf: PDFDocument, lines: PdfLine[]): Promise<number> {
  const { StandardFonts } = await import('pdf-lib');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = A4[0] - 2 * MARGIN;
  let page = pdf.addPage(A4);
  let pages = 1;
  let y = A4[1] - MARGIN;
  for (const l of lines) {
    const font = l.bold ? bold : regular;
    const size = l.size ?? 10;
    const lead = size * 1.35;
    y -= l.gap ?? 0;
    for (const part of wrap(font, encodable(font, l.text), size, width)) {
      if (y - lead < MARGIN) {
        page = pdf.addPage(A4);
        pages += 1;
        y = A4[1] - MARGIN;
      }
      y -= lead;
      if (part) page.drawText(part, { x: MARGIN, y, size, font });
    }
  }
  return pages;
}

function overviewPdfLines(o: Overview): PdfLine[] {
  const gaps = monthGaps(o.items.map((i) => docDay(i.doc)));
  const sorted = o.items.toSorted((a, b) => docDay(a.doc).localeCompare(docDay(b.doc)));
  return [
    { text: o.title, size: 18, bold: true },
    { text: `Erstellt am ${today()} · ${o.items.length} Dokument(e)`, gap: 4 },
    { text: 'Dokumente', size: 13, bold: true, gap: 12 },
    ...sorted.map((i, n) => ({
      text: [
        `${n + 1}. ${docDay(i.doc)} – ${i.doc.title}`,
        i.doc.docType,
        `Ordner: ${i.folder}`,
        i.amount === null ? null : euro(i.amount),
        o.notes.get(i.doc.id) ?? null,
      ]
        .filter(Boolean)
        .join(' | '),
      gap: 3,
    })),
    {
      text: withAmount(o.items) ? `Summe: ${euro(sumOf(o.items))} (aus ${withAmount(o.items)} Dokument(en) mit erkanntem Betrag)` : 'Kein Betrag erkannt.',
      bold: true,
      gap: 12,
    },
    { text: 'Lücken', size: 13, bold: true, gap: 12 },
    { text: gaps.length ? `Monate ohne Dokument: ${gaps.join(', ')}` : 'Keine Monate ohne Dokument zwischen dem ersten und dem letzten Dokument.', gap: 3 },
  ];
}

function markdownPdfLines(title: string, markdown: string): PdfLine[] {
  const out: PdfLine[] = [{ text: title, size: 18, bold: true }];
  let gap = 8;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      gap = 6;
      continue;
    }
    const h = /^(#{1,6}) +(\S.*)$/.exec(line);
    const clean = (s: string) => s.replaceAll('**', '').replaceAll('__', '').replaceAll('`', '');
    if (h) out.push({ text: clean(h[2]!), size: h[1]!.length === 1 ? 16 : h[1]!.length === 2 ? 13 : 11, bold: true, gap: gap + 6 });
    else out.push({ text: clean(line.replace(/^(\s*)[*-]\s+/, '$1• ')), gap });
    gap = 0;
  }
  return out;
}

// ---------- tools ----------
const DocRefs = list.describe('Dokument-IDs (D…) oder Ergebnismengen (S…)');

function modelLines(deps: ToolDeps, ctx: ToolContext, docs: DocumentRecord[], max = 25): string[] {
  const lines = docs.slice(0, max).map((d) => `- ${docLine(d, ctx, deps.privacy)}`);
  if (docs.length > max) lines.push(`- … und ${docs.length - max} weitere`);
  return lines;
}

export function exportTools(deps: ToolDeps): AgentTool[] {
  const { privacy } = deps;
  /** Sum for the model only when every counted document may be shared. */
  const sumNote = (items: Item[]) => {
    if (!withAmount(items)) return 'Kein Betrag erkannt.';
    const counted = items.filter((i) => i.amount !== null);
    if (counted.some((i) => !privacy.mayShareDocument(i.doc)))
      return `Summe aus ${counted.length} Dokument(en) steht in der Übersicht (enthält nicht freigegebene Dokumente).`;
    return `Summe: ${euro(sumOf(items))} (aus ${counted.length} Dokument(en) mit erkanntem Betrag).`;
  };

  return [
    defineTool({
      name: 'export_bundle',
      description:
        'Stellt Dokumente zu einer Mappe zusammen: als ZIP (Originaldateien + Übersicht.md/Übersicht.csv mit Datum, Titel, Typ, Ordner, erkanntem Betrag, Summe und Monatslücken) oder als ein PDF (Übersichtsseite + alle PDF-Dokumente angehängt). Die Datei wird lokal im Export-Ordner abgelegt, das Archiv bleibt unverändert. Mit saveAsCase werden die Dokumente zusätzlich einem Vorgang zugeordnet.',
      schema: z.object({
        documents: DocRefs,
        format: z.enum(['zip', 'pdf']).default('zip'),
        title: z.string().min(1).describe('Titel der Mappe, z. B. "Steuer 2025"'),
        overview: z.boolean().default(true).describe('Übersicht beilegen (Standard: ja)'),
        saveAsCase: optText.describe('Name eines Vorgangs, dem die Dokumente zugeordnet werden (optional)'),
      }),
      risk: 'write',
      label: (a) => `Stelle Mappe „${truncate(a.title, 60)}“ als ${a.format.toUpperCase()} zusammen`,
      count: () => 1,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
        if (!docs.length) return { content: `Keine Dokumente gefunden.${unknownNote(unknown)}`, isError: true };
        const items = collect(deps, docs);
        const missing = items.filter((i) => !i.file);
        const notes = new Map<string, string>(missing.map((i) => [i.doc.id, 'Datei fehlt']));
        let file: string;
        let pdfInfo = '';
        if (a.format === 'zip') {
          const { default: JSZip } = await import('jszip');
          const zip = new JSZip();
          const used = new Set<string>();
          for (const i of items) {
            if (!i.file) continue;
            const name = sanitizeFileName(i.doc.archiveRelPath ? path.posix.basename(i.doc.archiveRelPath) : i.doc.originalName);
            const ext = path.extname(name);
            const base = name.slice(0, name.length - ext.length);
            let unique = name;
            let n = 1;
            while (used.has(unique.toLowerCase()) || unique.startsWith('Übersicht.')) {
              n += 1;
              unique = `${base} (${n})${ext}`;
            }
            used.add(unique.toLowerCase());
            zip.file(unique, await fsp.readFile(i.file));
          }
          if (a.overview) {
            const o = { title: a.title, items, notes };
            zip.file('Übersicht.md', overviewMarkdown(o));
            zip.file('Übersicht.csv', overviewCsv(o));
          }
          file = await writeExport(deps, ctx, a.title, 'zip', await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
        } else {
          const { PDFDocument } = await import('pdf-lib');
          const sources: Array<{ item: Item; pdf: PDFDocument }> = [];
          for (const i of items) {
            if (!i.file) continue;
            if (i.doc.ext.toLowerCase() !== 'pdf') {
              notes.set(i.doc.id, 'nicht eingebunden (kein PDF)');
              continue;
            }
            try {
              sources.push({ item: i, pdf: await PDFDocument.load(await fsp.readFile(i.file), { ignoreEncryption: true }) });
            } catch {
              notes.set(i.doc.id, 'nicht eingebunden (PDF nicht lesbar)');
            }
          }
          const out = await PDFDocument.create();
          out.setTitle(a.title);
          out.setCreator('Archivist');
          const overviewPages = a.overview ? await drawText(out, overviewPdfLines({ title: a.title, items, notes })) : 0;
          let appended = 0;
          for (const s of sources) {
            const pages = await out.copyPages(s.pdf, s.pdf.getPageIndices());
            for (const p of pages) out.addPage(p);
            appended += pages.length;
          }
          if (!out.getPageCount()) await drawText(out, [{ text: a.title, size: 18, bold: true }]);
          file = await writeExport(deps, ctx, a.title, 'pdf', await out.save());
          const notIncluded = items.filter((i) => i.file && !sources.some((s) => s.item === i));
          pdfInfo = `\n${overviewPages} Übersichtsseite(n), ${sources.length} PDF-Dokument(e) mit ${appended} Seite(n) angehängt.${
            notIncluded.length
              ? `\nNicht eingebunden (kein PDF oder nicht lesbar):\n${modelLines(
                  deps,
                  ctx,
                  notIncluded.map((i) => i.doc),
                ).join('\n')}`
              : ''
          }`;
        }

        let caseInfo = '';
        if (a.saveAsCase) {
          const existed = deps.graph.findByName('case', a.saveAsCase);
          const c = deps.graph.ensureEntity('case', a.saveAsCase);
          if (!existed)
            deps.audit.log({ action: 'case.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [c.id], after: { name: c.name } });
          let linked = 0;
          for (const d of docs) {
            try {
              deps.graph.linkEntries(d.id, c.id, 'belongs_to', { status: 'confirmed', trigger: 'agent' });
              linked += 1;
            } catch {
              // a document without a graph node cannot be linked; it is still in the bundle
            }
          }
          caseInfo = `\nVorgang ${ctx.refs.entry(c.id)} „${truncate(c.name, 80)}“ ${existed ? 'ergänzt' : 'angelegt'}; ${linked} Dokument(e) zugeordnet.`;
          ctx.changes.push(`Vorgang „${c.name}“ ${existed ? 'ergänzt' : 'angelegt'} (${linked} Dokumente)`);
        }

        const included = items.length - missing.length;
        const change = `Mappe „${a.title}“ erstellt (${included} Dokument${included === 1 ? '' : 'e'})`;
        return {
          content: [
            `${change} – lokale Datei: ${file}`,
            `Das Archiv wurde nicht verändert.`,
            a.overview ? sumNote(items) : null,
            a.overview ? `Lücken: ${monthGaps(items.map((i) => docDay(i.doc))).join(', ') || 'keine'}` : null,
            missing.length
              ? `Datei fehlt (nicht enthalten):\n${modelLines(
                  deps,
                  ctx,
                  missing.map((i) => i.doc),
                ).join('\n')}`
              : null,
          ]
            .filter(Boolean)
            .join('\n')
            .concat(pdfInfo, caseInfo, unknownNote(unknown)),
          summary: `${included} Dokumente → ${path.basename(file)}`,
          change,
          changed: a.saveAsCase ? docs.length : 0,
        };
      },
    }),
    defineTool({
      name: 'export_csv',
      description:
        'Exportiert eine Dokumentliste als CSV für Excel (Semikolon, UTF-8). Spalten wählbar: datum, titel, typ, absender, betrag (erkannter Gesamtbetrag), ordner, thema, projekt, datei. Die Datei wird lokal im Export-Ordner abgelegt.',
      schema: z.object({
        documents: DocRefs,
        columns: z.array(z.enum(CSV_COLUMNS)).min(1).nullish().describe('Standard: alle Spalten'),
        title: optText.describe('Dateiname (optional)'),
      }),
      risk: 'write',
      label: (a) =>
        `Exportiere ${a.documents.length === 1 && /^S/i.test(a.documents[0]!) ? 'eine Ergebnismenge' : `${a.documents.length} Dokument(e)`} als CSV`,
      count: () => 1,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
        if (!docs.length) return { content: `Keine Dokumente gefunden.${unknownNote(unknown)}`, isError: true };
        const items = collect(deps, docs).toSorted((x, y) => docDay(x.doc).localeCompare(docDay(y.doc)));
        const columns = a.columns?.length ? CSV_COLUMNS.filter((c) => a.columns!.includes(c)) : CSV_COLUMNS;
        const file = await writeExport(deps, ctx, a.title ?? 'Dokumentliste', 'csv', toCsv(items, columns));
        const hidden = docs.filter((d) => !privacy.mayShareDocument(d)).length;
        const change = `CSV-Liste erstellt (${docs.length} Dokument${docs.length === 1 ? '' : 'e'})`;
        return {
          content: `${change} – lokale Datei: ${file}\nSpalten: ${columns.join(', ')}; ${docs.length} Zeile(n)${
            columns.includes('betrag') ? `, davon ${withAmount(items)} mit erkanntem Betrag` : ''
          }.${hidden ? ` ${hidden} Zeile(n) betreffen nicht freigegebene Dokumente (lokal vollständig, hier nicht gezeigt).` : ''}\nDas Archiv wurde nicht verändert.${unknownNote(unknown)}`,
          summary: `${docs.length} Zeilen → ${path.basename(file)}`,
          change,
        };
      },
    }),
    defineTool({
      name: 'write_report',
      description:
        'Speichert einen von dir verfassten Bericht (Markdown, mit Quellenangaben) als .md oder als einfaches PDF im Export-Ordner. Überschriften mit #, Aufzählungen mit -.',
      schema: z.object({
        title: z.string().min(1),
        markdown: z.string().min(1).describe('Inhalt in Markdown'),
        format: z.enum(['md', 'pdf']).default('md'),
      }),
      risk: 'write',
      label: (a) => `Schreibe Bericht „${truncate(a.title, 60)}“ (${a.format.toUpperCase()})`,
      count: () => 1,
      run: async (a, ctx) => {
        let file: string;
        if (a.format === 'md') {
          const body = /^#\s/.test(a.markdown.trimStart()) ? a.markdown : `# ${a.title}\n\n${a.markdown}`;
          file = await writeExport(deps, ctx, a.title, 'md', body.endsWith('\n') ? body : `${body}\n`);
        } else {
          const { PDFDocument } = await import('pdf-lib');
          const pdf = await PDFDocument.create();
          pdf.setTitle(a.title);
          pdf.setCreator('Archivist');
          const md = a.markdown.trimStart().startsWith(`# ${a.title}`) ? a.markdown.trimStart().slice(a.title.length + 2) : a.markdown;
          await drawText(pdf, markdownPdfLines(a.title, md));
          file = await writeExport(deps, ctx, a.title, 'pdf', await pdf.save());
        }
        const change = `Bericht „${a.title}“ erstellt`;
        return { content: `${change} – lokale Datei: ${file}`, summary: path.basename(file), change };
      },
    }),
    defineTool({
      name: 'draft_reply',
      description:
        'Legt einen Antwort-ENTWURF auf ein Schreiben (D…) an: als Notiz, die mit dem Dokument verknüpft ist, und als .md-Datei im Export-Ordner. Es wird nichts versendet.',
      schema: z.object({
        document: z.string().min(1).describe('Dokument-ID (D…) des Schreibens'),
        text: z.string().min(1).describe('Text des Antwortentwurfs'),
        title: optText,
      }),
      risk: 'write',
      label: () => 'Lege einen Antwortentwurf an',
      count: () => 1,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, [a.document]);
        const d = docs[0];
        if (!d) return { content: `Unbekannte Dokument-ID „${a.document}“.${unknownNote(unknown)}`, isError: true };
        const title = a.title ?? `Antwortentwurf: ${d.title}`;
        const { note, created } = await deps.notes.createUnlessExists({ content: a.text, title, links: [{ targetId: d.id, relationType: 'relates_to' }] });
        if (created) deps.audit.log({ action: 'note.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [note.id] });
        const file = await writeExport(deps, ctx, title, 'md', `# ${title}\n\nBezug: ${d.title} (${docDay(d)})\n\n${a.text.trim()}\n`);
        const change = `Antwortentwurf ${created ? 'angelegt' : 'war schon vorhanden'}`;
        return {
          content: `${change}: Notiz ${ctx.refs.entry(note.id)}, verknüpft mit ${docLine(d, ctx, privacy)}\nLokale Datei: ${file}\nEs wurde nichts versendet – der Entwurf liegt nur lokal.`,
          summary: 'Entwurf gespeichert (nicht versendet)',
          change,
        };
      },
    }),
  ];
}
