import fsp from 'node:fs/promises';
import { coreProps, decodeXml } from './office';
import { cleanText, type ParsedDocument } from './parsed-document';
import { elements, startTags } from './xml-scan';
import { readZipXml } from './zip-read';

const MAX_LINES_PER_SHEET = 3000;

/** Column letters ("AB") → 0-based index. */
const columnIndex = (ref: string): number => [...ref.replace(/[^A-Z]/gi, '').toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;

const textRuns = (xml: string) => [...elements(xml, 't')].map((run) => decodeXml(run.body)).join('');

const attribute = (tag: string, name: RegExp) => name.exec(tag)?.[1];

/** Relationship id → worksheet part name, from xl/_rels/workbook.xml.rels. */
function relationships(xml: string): Map<string, string> {
  return new Map(
    [...startTags(xml, 'Relationship')].flatMap((tag) => {
      const id = attribute(tag, /\bId="([^"]+)"/);
      const target = attribute(tag, /\bTarget="([^"]+)"/);
      return id && target ? [[id, target.replace(/^\/?(xl\/)?/, 'xl/')] as const] : [];
    }),
  );
}

function worksheets(parts: Map<string, string>): Array<{ name: string; xml: string }> {
  const targets = relationships(parts.get('xl/_rels/workbook.xml.rels') ?? '');
  return [...startTags(parts.get('xl/workbook.xml') ?? '', 'sheet')].flatMap((tag) => {
    const name = attribute(tag, /\bname="([^"]*)"/);
    const relationshipId = attribute(tag, /\br:id="([^"]+)"/);
    const target = relationshipId ? targets.get(relationshipId) : undefined;
    return name && target ? [{ name: decodeXml(name), xml: parts.get(target) ?? '' }] : [];
  });
}

function cellValue(attributes: string, body: string, shared: string[]): string {
  const type = attribute(attributes, /\bt="([^"]+)"/);
  const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
  if (type === 's' && raw !== undefined) return shared[Number(raw)] ?? '';
  if (type === 'inlineStr') return textRuns(body);
  return raw === undefined ? '' : decodeXml(raw);
}

/** Cells of one row by column (gaps stay empty); date cells appear as Excel serial numbers. */
function rowCells(rowXml: string, shared: string[]): string[] {
  const cells: string[] = [];
  for (const cell of elements(rowXml, 'c')) {
    const ref = attribute(cell.attributes, /\br="([A-Z]+)\d+"/) ?? '';
    const value = cellValue(cell.attributes, cell.body, shared);
    if (ref && value !== '') cells[columnIndex(ref)] = value;
  }
  return cells;
}

function sheetLines(sheetXml: string, shared: string[]): string[] {
  const lines: string[] = [];
  for (const row of elements(sheetXml, 'row')) {
    const cells = rowCells(row.body, shared);
    if (cells.length) lines.push(Array.from(cells, (value) => value ?? '').join(' | '));
    if (lines.length >= MAX_LINES_PER_SHEET) break;
  }
  return lines;
}

/** Own XLSX reader (ZIP + XML) – deliberately without SheetJS, whose npm version has known unpatched vulnerabilities. */
export async function parseXlsx(file: string): Promise<ParsedDocument> {
  const buffer = await fsp.readFile(file);
  const files = await readZipXml(buffer, /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$|^docProps\/core\.xml$/);
  const parts = new Map(files.map((part) => [part.name, part.xml]));
  const shared = [...elements(parts.get('xl/sharedStrings.xml') ?? '', 'si')].map((item) => textRuns(item.body));
  const sheets = worksheets(parts);
  const sections = sheets.map((sheet) => `Tabellenblatt „${sheet.name}“:\n${sheetLines(sheet.xml, shared).join('\n')}`);
  const core = parts.get('docProps/core.xml');
  const text = cleanText(sections.join('\n\n'));
  const hasData = sections.some((section) => section.includes('\n'));
  return {
    text: text.text,
    status: hasData ? 'extracted' : 'partial',
    error: hasData ? null : 'Die Arbeitsmappe enthält keine Daten.',
    meta: { sheets: sheets.length, ...(core ? coreProps(core) : {}) },
    truncated: text.truncated,
  };
}
