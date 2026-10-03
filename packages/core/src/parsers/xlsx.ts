import fsp from 'node:fs/promises';
import { coreProps, decodeXml, readZipXml } from './office';
import { cleanText, type ParsedDocument } from './parsed-document';

const MAX_LINES_PER_SHEET = 3000;

/** Column letters ("AB") → 0-based index. */
const columnIndex = (ref: string): number => [...ref.replace(/[^A-Z]/gi, '').toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;

const textRuns = (xml: string) => [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((match) => decodeXml(match[1] ?? '')).join('');

const attribute = (tag: string, name: RegExp) => name.exec(tag)?.[1];

/** Relationship id → worksheet part name, from xl/_rels/workbook.xml.rels. */
function relationships(xml: string): Map<string, string> {
  return new Map(
    [...xml.matchAll(/<Relationship\b[^>]*>/g)].flatMap((match) => {
      const id = attribute(match[0], /\bId="([^"]+)"/);
      const target = attribute(match[0], /\bTarget="([^"]+)"/);
      return id && target ? [[id, target.replace(/^\/?(xl\/)?/, 'xl/')] as const] : [];
    }),
  );
}

function worksheets(parts: Map<string, string>): Array<{ name: string; xml: string }> {
  const targets = relationships(parts.get('xl/_rels/workbook.xml.rels') ?? '');
  return [...(parts.get('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)].flatMap((match) => {
    const name = attribute(match[0], /\bname="([^"]*)"/);
    const relationshipId = attribute(match[0], /\br:id="([^"]+)"/);
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
  for (const cell of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attributes = cell[1] ?? '';
    const ref = attribute(attributes, /\br="([A-Z]+)\d+"/) ?? '';
    const value = cellValue(attributes, cell[2] ?? '', shared);
    if (ref && value !== '') cells[columnIndex(ref)] = value;
  }
  return cells;
}

function sheetLines(sheetXml: string, shared: string[]): string[] {
  const lines: string[] = [];
  for (const row of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = rowCells(row[1] ?? '', shared);
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
  const shared = [...(parts.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1] ?? ''));
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
