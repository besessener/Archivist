import path from 'node:path';
import { z } from 'zod';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolOutput } from '../registry';
import { affectedCount, docDay, docLine, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from './common';
import { exportBundle } from './exports/bundle';
import { CSV_COLUMNS, toCsv, type CsvColumn } from './exports/csv';
import { collectItems, writeExport } from './exports/files';
import { withAmount } from './exports/items';
import { drawText, markdownPdfLines } from './exports/pdf';

const DocRefs = list.describe('Dokument-IDs (D…) oder Ergebnismengen (S…)');

async function exportCsv(scope: ToolScope, args: { documents: string[]; columns?: CsvColumn[] | null; title: string | null }): Promise<ToolOutput> {
  const { deps } = scope;
  const { docs, unknown } = resolveDocs(scope, args.documents);
  if (!docs.length) return { content: `Keine Dokumente gefunden.${unknownNote(unknown)}`, isError: true };
  const items = collectItems(deps, docs).toSorted((x, y) => docDay(x.doc).localeCompare(docDay(y.doc)));
  const wanted = args.columns ?? [];
  const columns = wanted.length ? CSV_COLUMNS.filter((c) => wanted.includes(c)) : CSV_COLUMNS;
  const file = await writeExport(scope, { title: args.title ?? 'Dokumentliste', extension: 'csv', data: toCsv(items, columns) });
  const hidden = docs.filter((d) => !deps.privacy.mayShareDocument(d)).length;
  const change = `CSV-Liste erstellt (${docs.length} Dokument${docs.length === 1 ? '' : 'e'})`;
  const amountNote = columns.includes('betrag') ? `, davon ${withAmount(items)} mit erkanntem Betrag` : '';
  const hiddenNote = hidden ? ` ${hidden} Zeile(n) betreffen nicht freigegebene Dokumente (lokal vollständig, hier nicht gezeigt).` : '';
  return {
    content: `${change} – lokale Datei: ${file}\nSpalten: ${columns.join(', ')}; ${docs.length} Zeile(n)${amountNote}.${hiddenNote}\nDas Archiv wurde nicht verändert.${unknownNote(unknown)}`,
    summary: `${docs.length} Zeilen → ${path.basename(file)}`,
    change,
  };
}

async function writeReport(scope: ToolScope, args: { title: string; markdown: string; format: 'md' | 'pdf' }): Promise<ToolOutput> {
  const { title, markdown } = args;
  let file: string;
  if (args.format === 'md') {
    const body = /^#\s/.test(markdown.trimStart()) ? markdown : `# ${title}\n\n${markdown}`;
    file = await writeExport(scope, { title, extension: 'md', data: body.endsWith('\n') ? body : `${body}\n` });
  } else {
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    pdf.setCreator('Archivist');
    const content = markdown.trimStart().startsWith(`# ${title}`) ? markdown.trimStart().slice(title.length + 2) : markdown;
    await drawText(pdf, markdownPdfLines(title, content));
    file = await writeExport(scope, { title, extension: 'pdf', data: await pdf.save() });
  }
  const change = `Bericht „${title}“ erstellt`;
  return { content: `${change} – lokale Datei: ${file}`, summary: path.basename(file), change };
}

async function draftReply(scope: ToolScope, args: { document: string; text: string; title: string | null }): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs, unknown } = resolveDocs(scope, [args.document]);
  const d = docs[0];
  if (!d) return { content: `Unbekannte Dokument-ID „${args.document}“.${unknownNote(unknown)}`, isError: true };
  const title = args.title ?? `Antwortentwurf: ${d.title}`;
  const { note, created } = await deps.notes.createUnlessExists({ content: args.text, title, links: [{ targetId: d.id, relationType: 'relates_to' }] });
  if (created) deps.audit.log({ action: 'note.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [note.id] });
  const file = await writeExport(scope, { title, extension: 'md', data: `# ${title}\n\nBezug: ${d.title} (${docDay(d)})\n\n${args.text.trim()}\n` });
  const change = `Antwortentwurf ${created ? 'angelegt' : 'war schon vorhanden'}`;
  return {
    content: `${change}: Notiz ${ctx.refs.entry(note.id)}, verknüpft mit ${docLine(scope, d)}\nLokale Datei: ${file}\nEs wurde nichts versendet – der Entwurf liegt nur lokal.`,
    summary: 'Entwurf gespeichert (nicht versendet)',
    change,
  };
}

/** Producing results (#311): new files in the export folder of the data directory; the archive itself stays unchanged. */
export function exportTools(deps: ToolDeps): AgentTool[] {
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
      count: (a, ctx) => (a.saveAsCase ? affectedCount(ctx, a.documents) : 1),
      run: (a, ctx) => exportBundle({ deps, ctx }, a),
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
      run: (a, ctx) => exportCsv({ deps, ctx }, a),
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
      run: (a, ctx) => writeReport({ deps, ctx }, a),
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
      run: (a, ctx) => draftReply({ deps, ctx }, a),
    }),
  ];
}
