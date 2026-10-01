import fsp from 'node:fs/promises';
import path from 'node:path';

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
  tessdataDir?: string;
}

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

// eslint-disable-next-line no-control-regex
const tidy = (s: string) => s.replace(/\r\n/g, '\n').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();

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

async function parsePdf(file: string): Promise<ParsedDocument> {
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
    const c = clip(tidy(parts.join('\n\n')));
    const empty = c.text.length < 20;
    return {
      text: c.text,
      status: empty ? 'partial' : 'extracted',
      error: empty ? 'Kein Text gefunden (möglicherweise ein gescanntes Dokument; OCR ist für PDFs nicht aktiv).' : null,
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

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

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
  return { text: c.text, status: c.text ? 'extracted' : 'partial', error: c.text ? null : 'Keine Folientexte gefunden.', meta: { slides: slides.length, ...(core ? coreProps(core.xml) : {}) }, truncated: c.truncated };
}

async function parseXlsx(file: string): Promise<ParsedDocument> {
  const XLSX = await import('xlsx');
  const lib = (XLSX as unknown as { default?: typeof XLSX }).default ?? XLSX;
  const wb = lib.read(await fsp.readFile(file), { type: 'buffer', cellDates: true, sheetRows: 3000 });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    parts.push(`Tabellenblatt „${name}“:\n${lib.utils.sheet_to_csv(sheet, { FS: ' | ', blankrows: false })}`);
  }
  const c = clip(tidy(parts.join('\n\n')));
  const props = wb.Props ?? {};
  const meta: ParsedDocument['meta'] = { sheets: wb.SheetNames.length };
  if (props.Title) meta.title = props.Title;
  if (props.Author) meta.author = props.Author;
  return { text: c.text, status: c.text ? 'extracted' : 'partial', error: c.text ? null : 'Die Arbeitsmappe enthält keine Daten.', meta, truncated: c.truncated };
}

async function parseEml(file: string): Promise<ParsedDocument> {
  const { simpleParser } = await import('mailparser');
  const mail = await simpleParser(await fsp.readFile(file));
  const addr = (a: unknown) => (a && typeof a === 'object' && 'text' in a ? String((a as { text: string }).text) : '');
  const body = mail.text ?? (typeof mail.html === 'string' ? mail.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ') : '');
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
    meta: { title: mail.subject ?? null, from: addr(mail.from) || null, date: mail.date ? mail.date.toISOString() : null, attachments: mail.attachments.length },
    truncated: c.truncated,
  };
}

async function parseImage(file: string, opts: ParseOptions): Promise<ParsedDocument> {
  const sharp = (await import('sharp')).default;
  const info = await sharp(file, { failOn: 'none', limitInputPixels: 268_000_000 }).metadata();
  const meta: ParsedDocument['meta'] = { width: info.width ?? null, height: info.height ?? null, format: info.format ?? null, hasExif: Boolean(info.exif) };
  if (opts.ocrEnabled) {
    try {
      const tess = await import(/* @vite-ignore */ 'tesseract.js' as string).catch(() => null);
      if (!tess || !opts.tessdataDir) throw new Error('OCR-Komponente (tesseract.js oder lokale Sprachdaten) nicht verfügbar.');
      const worker = await tess.createWorker('deu+eng', 1, { langPath: opts.tessdataDir, cacheMethod: 'none', gzip: false });
      try {
        const res = await worker.recognize(file);
        const c = clip(tidy(res.data.text));
        return { text: c.text, status: c.text ? 'extracted' : 'partial', error: c.text ? null : 'OCR fand keinen Text.', meta, truncated: c.truncated };
      } finally {
        await worker.terminate();
      }
    } catch (err) {
      return { text: '', status: 'partial', error: `OCR fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, meta, truncated: false };
    }
  }
  return { text: '', status: 'partial', error: 'Bild ohne Textextraktion (OCR ist nicht aktiviert). Technische Metadaten wurden gespeichert.', meta, truncated: false };
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
        return await parsePdf(file);
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
        return { text: '', status: 'unsupported', error: `Dateityp „.${ext}“ wird nicht unterstützt; nur technische Metadaten werden archiviert.`, meta: {}, truncated: false };
    }
  } catch (err) {
    return { text: '', status: 'failed', error: `Verarbeitung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, meta: {}, truncated: false };
  }
}
