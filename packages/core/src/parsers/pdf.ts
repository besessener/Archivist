import fsp from 'node:fs/promises';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ocrOptionsFor, recognizeImage } from './ocr';
import { cleanText, errorMessage, MAX_TEXT_CHARS, type ParsedDocument, type ParseOptions } from './parsed-document';

const MAX_PDF_PAGES = 300;
const MAX_OCR_PAGES = 40;
/** Below this many characters a page (or a whole PDF) counts as empty, e.g. a scan without a text layer. */
const MIN_TEXT_CHARS = 20;

type TextItems = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'];

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

/** Text of each page in order; stops early once enough text is collected. */
async function textLayer(doc: PDFDocumentProxy, maxPages: number): Promise<string[]> {
  const pages: string[] = [];
  let total = 0;
  for (let pageNumber = 1; pageNumber <= maxPages && total < MAX_TEXT_CHARS; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const text = pageText((await page.getTextContent()).items);
    pages.push(text);
    total += text.length;
    page.cleanup();
  }
  return pages;
}

/** Renders one PDF page to a PNG (@napi-rs/canvas). */
async function renderPage(doc: PDFDocumentProxy, pageNumber: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1.5, 2000 / Math.max(base.width, 1)));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    page.cleanup();
  }
}

interface OcrOutcome {
  /** Recognized text by page index; pages without a result are absent. */
  recognized: Map<number, string>;
  skipped: number;
  error: string | null;
}

/** Local OCR of the pages without a text layer, one page at a time (a scan of 40 pages must not sit in memory as 40 PNGs). */
async function ocrBlankPages(doc: PDFDocumentProxy, pageTexts: string[], options: ParseOptions): Promise<OcrOutcome> {
  const blank = pageTexts.flatMap((text, index) => (text.length < MIN_TEXT_CHARS ? [index] : []));
  const chosen = blank.slice(0, options.maxOcrPages ?? MAX_OCR_PAGES);
  const outcome: OcrOutcome = { recognized: new Map(), skipped: blank.length - chosen.length, error: null };
  try {
    for (const index of chosen) {
      const result = await recognizeImage(await renderPage(doc, index + 1), ocrOptionsFor(options));
      const text = result.text.trim();
      if (text) outcome.recognized.set(index, text);
    }
  } catch (err) {
    outcome.error = `OCR fehlgeschlagen: ${errorMessage(err)}`;
  }
  return outcome;
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
    const pageTexts = await textLayer(doc, maxPages);
    let ocrError: string | null = null;
    let skippedPages = 0;
    if (options.ocrEnabled) {
      const ocr = await ocrBlankPages(doc, pageTexts, options);
      ocrError = ocr.error;
      for (const [index, text] of ocr.recognized) pageTexts[index] = text;
      if (ocr.recognized.size > 0) meta.ocr = true;
      skippedPages = ocr.skipped;
      if (skippedPages > 0) meta.ocrPagesSkipped = skippedPages;
    }
    const text = cleanText(pageTexts.join('\n\n'));
    const empty = text.text.length < MIN_TEXT_CHARS;
    return {
      text: text.text,
      status: empty || ocrError ? 'partial' : 'extracted',
      error: empty || ocrError ? emptyPdfError(options, ocrError) : null,
      meta,
      truncated: text.truncated || doc.numPages > maxPages || skippedPages > 0,
    };
  } finally {
    await task.destroy();
  }
}
