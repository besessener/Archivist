import fsp from 'node:fs/promises';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ParsedDocument, ParseOptions } from './index';
import { ocrOptionsFor, recognizeImages } from './ocr';
import { cleanText, errorMessage, MAX_TEXT_CHARS } from './text';

const MAX_PDF_PAGES = 300;
const MAX_OCR_PAGES = 40;
/** Below this many characters a PDF counts as empty (e.g. a scan without a text layer). */
const MIN_TEXT_CHARS = 20;

type TextItems = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'];
type CleanText = ReturnType<typeof cleanText>;

async function pdfMetadata(doc: PDFDocumentProxy): Promise<ParsedDocument['meta']> {
  const meta: ParsedDocument['meta'] = {};
  try {
    const info = (await doc.getMetadata()).info as Record<string, unknown> | undefined;
    if (!info) return meta;
    if (typeof info.Title === 'string' && info.Title.trim()) meta.title = info.Title.trim();
    if (typeof info.Author === 'string' && info.Author.trim()) meta.author = info.Author.trim();
    if (typeof info.CreationDate === 'string') meta.created = info.CreationDate;
  } catch {
    // metadata is optional
  }
  return meta;
}

function pageText(items: TextItems): string {
  let line = '';
  const lines: string[] = [];
  for (const item of items) {
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
  return lines.join('\n').trim();
}

async function textLayer(doc: PDFDocumentProxy, maxPages: number): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for (let pageNumber = 1; pageNumber <= maxPages && total < MAX_TEXT_CHARS; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const text = pageText((await page.getTextContent()).items);
    parts.push(text);
    total += text.length;
    page.cleanup();
  }
  return parts.join('\n\n');
}

/** Renders PDF pages to images (@napi-rs/canvas) and recognizes the text locally. */
async function ocrPdfPages(doc: PDFDocumentProxy, pages: number, options: ParseOptions): Promise<string> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const images: Buffer[] = [];
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1.5, 2000 / Math.max(base.width, 1)));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
    images.push(canvas.toBuffer('image/png'));
    page.cleanup();
  }
  const results = await recognizeImages(images, ocrOptionsFor(options));
  return results
    .map((result) => result.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Local OCR of a PDF without a text layer; on failure the error message instead of a text. */
async function ocrText(doc: PDFDocumentProxy, options: ParseOptions): Promise<{ text: CleanText } | { error: string }> {
  try {
    return { text: cleanText(await ocrPdfPages(doc, Math.min(doc.numPages, MAX_OCR_PAGES), options)) };
  } catch (err) {
    return { error: `OCR fehlgeschlagen: ${errorMessage(err)}` };
  }
}

function emptyPdfError(options: ParseOptions, ocrError: string | null): string {
  if (ocrError) return ocrError;
  return options.ocrEnabled ? 'OCR fand keinen Text.' : 'Kein Text gefunden (möglicherweise ein gescanntes Dokument; OCR ist deaktiviert).';
}

export async function parsePdf(file: string, options: ParseOptions): Promise<ParsedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fsp.readFile(file));
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const meta: ParsedDocument['meta'] = { pages: doc.numPages, ...(await pdfMetadata(doc)) };
    const maxPages = Math.min(doc.numPages, MAX_PDF_PAGES);
    let text = cleanText(await textLayer(doc, maxPages));
    let ocrError: string | null = null;
    if (text.text.length < MIN_TEXT_CHARS && options.ocrEnabled) {
      const ocr = await ocrText(doc, options);
      if ('error' in ocr) ocrError = ocr.error;
      else {
        text = ocr.text;
        meta.ocr = true;
      }
    }
    const empty = text.text.length < MIN_TEXT_CHARS;
    return {
      text: text.text,
      status: empty ? 'partial' : 'extracted',
      error: empty ? emptyPdfError(options, ocrError) : null,
      meta,
      truncated: text.truncated || doc.numPages > maxPages,
    };
  } finally {
    await task.destroy();
  }
}
