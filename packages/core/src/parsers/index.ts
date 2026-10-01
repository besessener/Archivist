import fsp from 'node:fs/promises';
import path from 'node:path';
import { recognizeImages, type OcrOptions } from './ocr';

export type ParseStatus = 'extracted' | 'partial' | 'unsupported' | 'failed';

export interface ParsedDocument {
  text: string;
  status: ParseStatus;
  error: string | null;
  meta: Record<string, string | number | boolean | null>;
  truncated: boolean;
}

export interface ParseOptions {
  ocrEnabled?: boolean;
  ocrLanguages?: string;
  tessdataDir?: string;
}

const ocrOptions = (opts: ParseOptions): OcrOptions => ({
  tessdataDir: opts.tessdataDir ?? path.join(process.cwd(), 'tessdata'),
  languages: opts.ocrLanguages ?? 'deu+eng',
});

export const MAX_TEXT_CHARS = 400_000;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

export const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  eml: 'message/rfc822',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

const clip = (text: string): { text: string; truncated: boolean } =>
  text.length > MAX_TEXT_CHARS ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true } : { text, truncated: false };

/** Entfernt Leerzeichen/Tabs am Zeilenende ohne Regex (ein Muster wie `[ \t]+\n` wäre bei langen Leerzeichenfolgen quadratisch). */
const trimLineEnd = (line: string): string => {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return end === line.length ? line : line.slice(0, end);
};
const tidy = (s: string) =>
  s
    .replaceAll('\r\n', '\n')
    .replaceAll('\u0000', '')
    .split('\n')
    .map(trimLineEnd)
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  // viele Ersatzzeichen deuten auf Latin-1/Windows-1252 hin
  const bad = (utf8.match(/�/g) ?? []).length;
  return bad > 3 && bad / Math.max(utf8.length, 1) > 0.002 ? buf.toString('latin1') : utf8;
}

async function parsePlain(file: string): Promise<ParsedDocument> {
  const fh = await fsp.open(file, 'r');
  try {
    const stat = await fh.stat();
    const len = Math.min(stat.size, MAX_TEXT_FILE_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const c = clip(tidy(decodeText(buf)));
    return { text: c.text, status: 'extracted', error: null, meta: { bytes: stat.size }, truncated: c.truncated || stat.size > len };
  } finally {
    await fh.close();
  }
}

const MAX_OCR_PAGES = 40;

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvas: never; canvasContext: never; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

/** Rendert PDF-Seiten zu Bildern (@napi-rs/canvas) und erkennt den Text lokal. */
async function ocrPdfPages(doc: { getPage(n: number): Promise<unknown> }, pages: number, opts: ParseOptions): Promise<string> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const images: Buffer[] = [];
  for (let i = 1; i <= pages; i += 1) {
    const page = (await doc.getPage(i)) as PdfPage;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1.5, 2000 / Math.max(base.width, 1)));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    images.push(canvas.toBuffer('image/png'));
    page.cleanup();
  }
  const results = await recognizeImages(images, ocrOptions(opts));
  return results
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

async function parsePdf(file: string, opts: ParseOptions): Promise<ParsedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fsp.readFile(file));
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const meta: ParsedDocument['meta'] = { pages: doc.numPages };
    try {
      const info = (await doc.getMetadata()).info as Record<string, unknown> | undefined;
      if (info) {
        if (typeof info.Title === 'string' && info.Title.trim()) meta.title = info.Title.trim();
        if (typeof info.Author === 'string' && info.Author.trim()) meta.author = info.Author.trim();
        if (typeof info.CreationDate === 'string') meta.created = info.CreationDate;
      }
    } catch {
      /* Metadaten optional */
    }
    const parts: string[] = [];
    const maxPages = Math.min(doc.numPages, 300);
    let total = 0;
    for (let i = 1; i <= maxPages && total < MAX_TEXT_CHARS; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        } else if (item.str && !item.str.endsWith(' ')) {
          line += ' ';
        }
      }
      if (line) lines.push(line);
      const pageText = lines.join('\n').trim();
      parts.push(pageText);
      total += pageText.length;
      page.cleanup();
    }
    let c = clip(tidy(parts.join('\n\n')));
    let empty = c.text.length < 20;
    let ocrError: string | null = null;
    if (empty && opts.ocrEnabled) {
      try {
        const ocrText = await ocrPdfPages(doc, Math.min(doc.numPages, MAX_OCR_PAGES), opts);
        c = clip(tidy(ocrText));
        empty = c.text.length < 20;
        meta.ocr = true;
      } catch (err) {
        ocrError = `OCR fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return {
      text: c.text,
      status: empty ? 'partial' : 'extracted',
      error: empty
        ? (ocrError ?? (opts.ocrEnabled ? 'OCR fand keinen Text.' : 'Kein Text gefunden (möglicherweise ein gescanntes Dokument; OCR ist deaktiviert).'))
        : null,
      meta,
      truncated: c.truncated || doc.numPages > maxPages,
    };
  } finally {
    await task.destroy();
  }
}

async function readZipXml(buf: Buffer, names: RegExp): Promise<Array<{ name: string; xml: string }>> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buf);
  const out: Array<{ name: string; xml: string }> = [];
  for (const name of Object.keys(zip.files)) {
    if (names.test(name) && !zip.files[name]!.dir) out.push({ name, xml: await zip.files[name]!.async('string') });
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function coreProps(xml: string): ParsedDocument['meta'] {
  const meta: ParsedDocument['meta'] = {};
  const pick = (tag: string) => new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml)?.[1];
  const title = pick('dc:title');
  const creator = pick('dc:creator');
  const created = pick('dcterms:created');
  if (title) meta.title = decodeXml(title);
  if (creator) meta.author = decodeXml(creator);
  if (created) meta.created = created;
  return meta;
}

async function parseDocx(file: string): Promise<ParsedDocument> {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const buf = await fsp.readFile(file);
  const result = await mammoth.extractRawText({ buffer: buf });
  let meta: ParsedDocument['meta'] = {};
  try {
    const core = await readZipXml(buf, /^docProps\/core\.xml$/);
    if (core[0]) meta = coreProps(core[0].xml);
  } catch {
    /* optional */
  }
  const c = clip(tidy(result.value));
  return { text: c.text, status: c.text ? 'extracted' : 'partial', error: c.text ? null : 'Das Dokument enthält keinen Text.', meta, truncated: c.truncated };
}

async function parsePptx(file: string): Promise<ParsedDocument> {
  const buf = await fsp.readFile(file);
  const files = await readZipXml(buf, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$|^docProps\/core\.xml$/);
  // eslint-disable-next-line sonarjs/super-linear-regex -- Dateiname bzw. HTML-Ausschnitt, Länge begrenzt
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const textOf = (xml: string) =>
    [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)]
      .map((p) => [...p[0].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1] ?? '')).join(''))
      .filter(Boolean)
      .join('\n');
  const slides = files.filter((f) => f.name.startsWith('ppt/slides/')).sort((a, b) => num(a.name) - num(b.name));
  const notes = new Map(files.filter((f) => f.name.startsWith('ppt/notesSlides/')).map((f) => [num(f.name), textOf(f.xml)]));
  const parts = slides.map((s, i) => {
    const n = notes.get(num(s.name));
    return `Folie ${i + 1}:\n${textOf(s.xml)}${n ? `\nNotizen: ${n}` : ''}`;
  });
  const core = files.find((f) => f.name === 'docProps/core.xml');
  const c = clip(tidy(parts.join('\n\n')));
  return {
    text: c.text,
    status: c.text ? 'extracted' : 'partial',
    error: c.text ? null : 'Keine Folientexte gefunden.',
    meta: { slides: slides.length, ...(core ? coreProps(core.xml) : {}) },
    truncated: c.truncated,
  };
}

/** Spaltenbuchstaben ("AB") → 0-basierter Index. */
const colIndex = (ref: string): number => [...ref.replace(/[^A-Z]/gi, '').toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/**
 * Eigener, abhängigkeitsarmer XLSX-Leser (ZIP + XML): liest Tabellenblätter als Text.
 * Bewusst ohne SheetJS (die auf npm verfügbare Version hat bekannte, ungepatchte Schwachstellen).
 * Datumszellen erscheinen als Excel-Seriennummer.
 */
async function parseXlsx(file: string): Promise<ParsedDocument> {
  const buf = await fsp.readFile(file);
  const files = await readZipXml(buf, /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$|^docProps\/core\.xml$/);
  const byName = new Map(files.map((f) => [f.name, f.xml]));
  const text = (xml: string) => [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1] ?? '')).join('');
  const shared = [...(byName.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1] ?? ''));
  const rels = new Map(
    [...(byName.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].flatMap((m) => {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      return id && target ? [[id, target.replace(/^\/?(xl\/)?/, 'xl/')] as const] : [];
    }),
  );
  const sheets = [...(byName.get('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)].flatMap((m) => {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const target = rid ? rels.get(rid) : undefined;
    return name && target ? [{ name: decodeXml(name), xml: byName.get(target) ?? '' }] : [];
  });
  const parts: string[] = [];
  for (const sheet of sheets) {
    const lines: string[] = [];
    for (const row of sheet.xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '';
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        let value = '';
        if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = text(body);
        else if (raw !== undefined) value = decodeXml(raw);
        if (ref && value !== '') cells[colIndex(ref)] = value;
      }
      if (cells.length) lines.push(Array.from(cells, (v) => v ?? '').join(' | '));
      if (lines.length >= 3000) break;
    }
    parts.push(`Tabellenblatt „${sheet.name}“:\n${lines.join('\n')}`);
  }
  const core = byName.get('docProps/core.xml');
  const c = clip(tidy(parts.join('\n\n')));
  const hasData = parts.some((p) => p.includes('\n'));
  return {
    text: c.text,
    status: hasData ? 'extracted' : 'partial',
    error: hasData ? null : 'Die Arbeitsmappe enthält keine Daten.',
    meta: { sheets: sheets.length, ...(core ? coreProps(core) : {}) },
    truncated: c.truncated,
  };
}

async function parseEml(file: string): Promise<ParsedDocument> {
  const { simpleParser } = await import('mailparser');
  const mail = await simpleParser(await fsp.readFile(file));
  const addr = (a: unknown) => (a && typeof a === 'object' && 'text' in a ? String((a as { text: string }).text) : '');
  const body =
    mail.text ?? (typeof mail.html === 'string' ? mail.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^<>]+>/g, ' ') : '');
  const header = [
    `Betreff: ${mail.subject ?? ''}`,
    `Von: ${addr(mail.from)}`,
    `An: ${addr(mail.to)}`,
    mail.cc ? `Cc: ${addr(mail.cc)}` : '',
    `Datum: ${mail.date ? mail.date.toISOString() : ''}`,
    mail.attachments.length ? `Anhänge: ${mail.attachments.map((a) => a.filename ?? 'unbenannt').join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const c = clip(tidy(`${header}\n\n${body}`));
  return {
    text: c.text,
    status: 'extracted',
    error: null,
    meta: {
      title: mail.subject ?? null,
      from: addr(mail.from) || null,
      date: mail.date ? mail.date.toISOString() : null,
      attachments: mail.attachments.length,
    },
    truncated: c.truncated,
  };
}

async function parseImage(file: string, opts: ParseOptions): Promise<ParsedDocument> {
  const sharp = (await import('sharp')).default;
  const info = await sharp(file, { failOn: 'none', limitInputPixels: 268_000_000 }).metadata();
  const meta: ParsedDocument['meta'] = { width: info.width ?? null, height: info.height ?? null, format: info.format ?? null, hasExif: Boolean(info.exif) };
  if (opts.ocrEnabled) {
    try {
      const [res] = await recognizeImages([file], ocrOptions(opts));
      const c = clip(tidy(res?.text ?? ''));
      return {
        text: c.text,
        status: c.text ? 'extracted' : 'partial',
        error: c.text ? null : 'OCR fand keinen Text.',
        meta: { ...meta, ocr: true, ocrConfidence: Math.round(res?.confidence ?? 0) },
        truncated: c.truncated,
      };
    } catch (err) {
      return { text: '', status: 'partial', error: `OCR fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, meta, truncated: false };
    }
  }
  return {
    text: '',
    status: 'partial',
    error: 'Bild ohne Textextraktion (OCR ist nicht aktiviert). Technische Metadaten wurden gespeichert.',
    meta,
    truncated: false,
  };
}

/** Extrahiert Text und technische Metadaten. Wirft nicht: Fehler werden als Status zurückgegeben (Datei wird nie verworfen). */
export async function parseDocument(file: string, opts: ParseOptions = {}): Promise<ParsedDocument> {
  const ext = path.extname(file).slice(1).toLowerCase();
  try {
    switch (ext) {
      case 'txt':
      case 'md':
      case 'markdown':
        return await parsePlain(file);
      case 'pdf':
        return await parsePdf(file, opts);
      case 'docx':
        return await parseDocx(file);
      case 'pptx':
        return await parsePptx(file);
      case 'xlsx':
        return await parseXlsx(file);
      case 'eml':
        return await parseEml(file);
      case 'png':
      case 'jpg':
      case 'jpeg':
        return await parseImage(file, opts);
      default:
        return {
          text: '',
          status: 'unsupported',
          error: `Dateityp „.${ext}“ wird nicht unterstützt; nur technische Metadaten werden archiviert.`,
          meta: {},
          truncated: false,
        };
    }
  } catch (err) {
    return {
      text: '',
      status: 'failed',
      error: `Verarbeitung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      meta: {},
      truncated: false,
    };
  }
}
