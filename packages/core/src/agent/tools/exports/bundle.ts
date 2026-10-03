import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PDFDocument } from 'pdf-lib';
import type { DocumentRecord } from '@archivist/shared';
import { sanitizeFileName } from '../../../util/paths';
import { truncate } from '../../../util/text';
import type { ToolOutput } from '../../registry';
import { docDay, docLine, resolveDocs, unknownNote, type ToolScope } from '../common';
import { collectItems, today, writeExport } from './files';
import { formatAmount, monthGaps, sumOf, withAmount, type ExportItem } from './items';
import { overviewCsv, overviewMarkdown, overviewPdfLines, type Overview } from './overview';
import { drawText } from './pdf';

export interface BundleArgs {
  documents: string[];
  format: 'zip' | 'pdf';
  title: string;
  overview: boolean;
  saveAsCase: string | null;
}

interface Bundle {
  overview: Overview;
  /** whether the overview goes into the bundle */
  withOverview: boolean;
}

const MODEL_LINES = 25;

/** Privacy-filtered lines about documents for the model, at most 25. */
function modelLines(scope: ToolScope, docs: DocumentRecord[]): string[] {
  const lines = docs.slice(0, MODEL_LINES).map((d) => `- ${docLine(scope, d)}`);
  if (docs.length > MODEL_LINES) lines.push(`- … und ${docs.length - MODEL_LINES} weitere`);
  return lines;
}

/** Name of a file inside the ZIP, unique (case-insensitive) and never the overview's name; marks it as used. */
function claimEntryName(doc: DocumentRecord, used: Set<string>): string {
  const name = sanitizeFileName(doc.archiveRelPath ? path.posix.basename(doc.archiveRelPath) : doc.originalName);
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let unique = name;
  let n = 1;
  while (used.has(unique.toLowerCase()) || unique.startsWith('Übersicht.')) {
    n += 1;
    unique = `${base} (${n})${ext}`;
  }
  used.add(unique.toLowerCase());
  return unique;
}

async function zipBundle(scope: ToolScope, { overview, withOverview }: Bundle): Promise<{ file: string; info: string }> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set<string>();
  for (const i of overview.items) {
    if (!i.file) continue;
    zip.file(claimEntryName(i.doc, used), await fsp.readFile(i.file));
  }
  if (withOverview) {
    zip.file('Übersicht.md', overviewMarkdown(overview));
    zip.file('Übersicht.csv', overviewCsv(overview));
  }
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { file: await writeExport(scope, { title: overview.title, extension: 'zip', data }), info: '' };
}

/** The readable PDFs of the bundle; every other document gets a note why it is not included. */
async function pdfSources(overview: Overview): Promise<Array<{ item: ExportItem; pdf: PDFDocument }>> {
  const { PDFDocument } = await import('pdf-lib');
  const sources: Array<{ item: ExportItem; pdf: PDFDocument }> = [];
  for (const i of overview.items) {
    if (!i.file) continue;
    if (i.doc.ext.toLowerCase() !== 'pdf') {
      overview.notes.set(i.doc.id, 'nicht eingebunden (kein PDF)');
      continue;
    }
    try {
      sources.push({ item: i, pdf: await PDFDocument.load(await fsp.readFile(i.file), { ignoreEncryption: true }) });
    } catch {
      overview.notes.set(i.doc.id, 'nicht eingebunden (PDF nicht lesbar)');
    }
  }
  return sources;
}

async function pdfBundle(scope: ToolScope, { overview, withOverview }: Bundle): Promise<{ file: string; info: string }> {
  const { PDFDocument } = await import('pdf-lib');
  const sources = await pdfSources(overview);
  const out = await PDFDocument.create();
  out.setTitle(overview.title);
  out.setCreator('Archivist');
  const overviewPages = withOverview ? await drawText(out, overviewPdfLines(overview)) : 0;
  let appended = 0;
  for (const source of sources) {
    const pages = await out.copyPages(source.pdf, source.pdf.getPageIndices());
    for (const page of pages) out.addPage(page);
    appended += pages.length;
  }
  if (!out.getPageCount()) await drawText(out, [{ text: overview.title, size: 18, bold: true }]);
  const file = await writeExport(scope, { title: overview.title, extension: 'pdf', data: await out.save() });
  const notIncluded = overview.items.filter((i) => i.file && !sources.some((s) => s.item === i));
  const notIncludedNote = notIncluded.length
    ? `\nNicht eingebunden (kein PDF oder nicht lesbar):\n${modelLines(
        scope,
        notIncluded.map((i) => i.doc),
      ).join('\n')}`
    : '';
  return { file, info: `\n${overviewPages} Übersichtsseite(n), ${sources.length} PDF-Dokument(e) mit ${appended} Seite(n) angehängt.${notIncludedNote}` };
}

/** Assigns the documents to a case (created when new); returns the note for the model and the visible change. */
function assignCase(scope: ToolScope, assignment: { name: string; docs: DocumentRecord[] }): { info: string; change: string } {
  const { deps, ctx } = scope;
  const existed = deps.graph.findByName('case', assignment.name);
  const caseEntity = deps.graph.ensureEntity({ type: 'case', name: assignment.name });
  if (!existed)
    deps.audit.log({ action: 'case.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [caseEntity.id], after: { name: caseEntity.name } });
  let linked = 0;
  for (const d of assignment.docs) {
    try {
      deps.graph.linkEntries({ sourceId: d.id, targetId: caseEntity.id, relationType: 'belongs_to' }, { status: 'confirmed', trigger: 'agent' });
      linked += 1;
    } catch {
      // a document without a graph node cannot be linked; it is still in the bundle
    }
  }
  return {
    info: `\nVorgang ${ctx.refs.entry(caseEntity.id)} „${truncate(caseEntity.name, 80)}“ ${existed ? 'ergänzt' : 'angelegt'}; ${linked} Dokument(e) zugeordnet.`,
    change: `Vorgang „${caseEntity.name}“ ${existed ? 'ergänzt' : 'angelegt'} (${linked} Dokumente)`,
  };
}

/** Sum for the model only when every counted document may be shared. */
function sumNote(scope: ToolScope, items: ExportItem[]): string {
  if (!withAmount(items)) return 'Kein Betrag erkannt.';
  const counted = items.filter((i) => i.amount !== null);
  if (counted.some((i) => !scope.deps.privacy.mayShareDocument(i.doc)))
    return `Summe aus ${counted.length} Dokument(en) steht in der Übersicht (enthält nicht freigegebene Dokumente).`;
  return `Summe: ${formatAmount(sumOf(items))} (aus ${counted.length} Dokument(en) mit erkanntem Betrag).`;
}

export async function exportBundle(scope: ToolScope, args: BundleArgs): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs, unknown } = resolveDocs(scope, args.documents);
  if (!docs.length) return { content: `Keine Dokumente gefunden.${unknownNote(unknown)}`, isError: true };
  const items = collectItems(deps, docs);
  const missing = items.filter((i) => !i.file);
  const overview: Overview = { title: args.title, created: today(), items, notes: new Map(missing.map((i) => [i.doc.id, 'Datei fehlt'])) };
  const bundle = { overview, withOverview: args.overview };
  const { file, info } = args.format === 'zip' ? await zipBundle(scope, bundle) : await pdfBundle(scope, bundle);
  let caseInfo = '';
  if (args.saveAsCase) {
    const assigned = assignCase(scope, { name: args.saveAsCase, docs });
    ctx.changes.push(assigned.change);
    caseInfo = assigned.info;
  }
  const included = items.length - missing.length;
  const change = `Mappe „${args.title}“ erstellt (${included} Dokument${included === 1 ? '' : 'e'})`;
  return {
    content: [
      `${change} – lokale Datei: ${file}`,
      `Das Archiv wurde nicht verändert.`,
      args.overview ? sumNote(scope, items) : null,
      args.overview ? `Lücken: ${monthGaps(items.map((i) => docDay(i.doc))).join(', ') || 'keine'}` : null,
      missing.length
        ? `Datei fehlt (nicht enthalten):\n${modelLines(
            scope,
            missing.map((i) => i.doc),
          ).join('\n')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n')
      .concat(info, caseInfo, unknownNote(unknown)),
    summary: `${included} Dokumente → ${path.basename(file)}`,
    change,
    changed: args.saveAsCase ? docs.length : 0,
  };
}
