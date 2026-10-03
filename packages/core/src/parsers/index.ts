import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ParsedMail } from 'mailparser';
import { visibleHtmlText } from './html-text';
import { ocrOptionsFor, recognizeImages } from './ocr';
import { parseDocx, parsePptx } from './office';
import { parsePdf } from './pdf';
import { cleanText, errorMessage, type ParsedDocument, type ParseOptions } from './parsed-document';
import { parseXlsx } from './xlsx';

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

function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  const utf8 = buffer.toString('utf8');
  // many replacement characters indicate Latin-1/Windows-1252
  const replacements = (utf8.match(/�/g) ?? []).length;
  return replacements > 3 && replacements / Math.max(utf8.length, 1) > 0.002 ? buffer.toString('latin1') : utf8;
}

async function parsePlain(file: string): Promise<ParsedDocument> {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_TEXT_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const text = cleanText(decodeText(buffer));
    return { text: text.text, status: 'extracted', error: null, meta: { bytes: stat.size }, truncated: text.truncated || stat.size > length };
  } finally {
    await handle.close();
  }
}

const addressText = (address: unknown) => (address && typeof address === 'object' && 'text' in address ? String((address as { text: string }).text) : '');

function mailBody(mail: ParsedMail): string {
  if (mail.text?.trim()) return mail.text;
  return typeof mail.html === 'string' ? visibleHtmlText(mail.html) : '';
}

async function parseEml(file: string): Promise<ParsedDocument> {
  const { simpleParser } = await import('mailparser');
  // HTML-only mails are converted here instead of by mailparser: its conversion keeps hidden text (#199)
  const mail = await simpleParser(await fsp.readFile(file), { skipHtmlToText: true });
  const body = mailBody(mail);
  const header = [
    `Betreff: ${mail.subject ?? ''}`,
    `Von: ${addressText(mail.from)}`,
    `An: ${addressText(mail.to)}`,
    mail.cc ? `Cc: ${addressText(mail.cc)}` : '',
    `Datum: ${mail.date ? mail.date.toISOString() : ''}`,
    mail.attachments.length ? `Anhänge: ${mail.attachments.map((attachment) => attachment.filename ?? 'unbenannt').join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const text = cleanText(`${header}\n\n${body}`);
  return {
    text: text.text,
    status: 'extracted',
    error: null,
    meta: {
      title: mail.subject ?? null,
      from: addressText(mail.from) || null,
      date: mail.date ? mail.date.toISOString() : null,
      attachments: mail.attachments.length,
      messageId: mail.messageId ?? null,
      inReplyTo: mail.inReplyTo ?? null,
      references: [mail.references ?? []].flat().join(' ') || null,
    },
    truncated: text.truncated,
  };
}

async function parseImage(file: string, options: ParseOptions): Promise<ParsedDocument> {
  const sharp = (await import('sharp')).default;
  const info = await sharp(file, { failOn: 'none', limitInputPixels: 268_000_000 }).metadata();
  const meta: ParsedDocument['meta'] = { width: info.width ?? null, height: info.height ?? null, format: info.format ?? null, hasExif: Boolean(info.exif) };
  if (!options.ocrEnabled) {
    return {
      text: '',
      status: 'partial',
      error: 'Bild ohne Textextraktion (OCR ist nicht aktiviert). Technische Metadaten wurden gespeichert.',
      meta,
      truncated: false,
    };
  }
  try {
    const [result] = await recognizeImages([file], ocrOptionsFor(options));
    const text = cleanText(result?.text ?? '');
    return {
      text: text.text,
      status: text.text ? 'extracted' : 'partial',
      error: text.text ? null : 'OCR fand keinen Text.',
      meta: { ...meta, ocr: true, ocrConfidence: Math.round(result?.confidence ?? 0) },
      truncated: text.truncated,
    };
  } catch (err) {
    return { text: '', status: 'partial', error: `OCR fehlgeschlagen: ${errorMessage(err)}`, meta, truncated: false };
  }
}

const PARSERS: Record<string, (file: string, options: ParseOptions) => Promise<ParsedDocument>> = {
  txt: parsePlain,
  md: parsePlain,
  markdown: parsePlain,
  pdf: parsePdf,
  docx: parseDocx,
  pptx: parsePptx,
  xlsx: parseXlsx,
  eml: parseEml,
  png: parseImage,
  jpg: parseImage,
  jpeg: parseImage,
};

/** Extracts text and technical metadata. Does not throw: errors are returned as a status (the file is never discarded). */
export async function parseDocument(file: string, options: ParseOptions = {}): Promise<ParsedDocument> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const parser = Object.hasOwn(PARSERS, ext) ? PARSERS[ext] : undefined;
  if (!parser) {
    return {
      text: '',
      status: 'unsupported',
      error: `Dateityp „.${ext}“ wird nicht unterstützt; nur technische Metadaten werden archiviert.`,
      meta: {},
      truncated: false,
    };
  }
  try {
    return await parser(file, options);
  } catch (err) {
    return { text: '', status: 'failed', error: `Verarbeitung fehlgeschlagen: ${errorMessage(err)}`, meta: {}, truncated: false };
  }
}
