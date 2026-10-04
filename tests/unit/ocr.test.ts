import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '../../packages/core/src/parsers';
import { releaseOcrWorker } from '../../packages/core/src/parsers/ocr';

const TEXT = ['Rechnung 4711', 'Zahlungsziel 30 Tage', 'Archivist Testlauf'];
const W = 1000;
const H = 360;
let dir: string;
let png: string;
let pdf: string;
let scan: Buffer;
const opts = () => ({ ocrEnabled: true, ocrLanguages: 'deu+eng', tessdataDir: path.join(dir, 'tessdata') });

interface PdfPage {
  /** Text layer line; a page without it relies on its image alone. */
  text?: string;
  jpeg?: Buffer;
}

/** Minimal PDF with one page per entry: an optional text line and an optional full-page JPEG (a simulated scan). */
function pdfOf(pages: PdfPage[]): Buffer {
  const latin1 = (text: string) => Buffer.from(text, 'latin1');
  const objects: Array<Buffer | string> = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: number[] = [];
  for (const page of pages) {
    const pageNumber = objects.length + 1;
    kids.push(pageNumber);
    const content = `${page.text ? `BT /F1 24 Tf 40 300 Td (${page.text}) Tj ET ` : ''}${page.jpeg ? `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q` : ''}`;
    const images = page.jpeg ? `/XObject << /Im0 ${pageNumber + 2} 0 R >>` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${pageNumber + 1} 0 R /Resources << /Font << /F1 3 0 R >> ${images} >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    if (page.jpeg) {
      const head = `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`;
      objects.push(Buffer.concat([latin1(head), page.jpeg, latin1('\nendstream')]));
    }
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  const parts: Buffer[] = [latin1('%PDF-1.4\n')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([latin1(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const table = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(
    latin1(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`),
  );
  return Buffer.concat(parts);
}

const writePdf = (name: string, pages: PdfPage[]) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, pdfOf(pages));
  return file;
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-ocr-'));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>${TEXT.map((t, i) => `<text x="40" y="${90 + i * 100}" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" fill="black">${t}</text>`).join('')}</svg>`;
  png = path.join(dir, 'scan.png');
  await sharp(Buffer.from(svg)).png().toFile(png);
  scan = await sharp(png).grayscale().jpeg({ quality: 95 }).toBuffer();
  pdf = writePdf('scan.pdf', [{ jpeg: scan }]);
});

afterAll(async () => {
  await releaseOcrWorker();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OCR (offline, tesseract.js)', () => {
  it('recognises text in an image', async () => {
    const res = await parseDocument(png, opts());
    expect(res.error).toBeNull();
    expect(res.status).toBe('extracted');
    expect(res.text).toContain('Rechnung');
    expect(res.text).toContain('4711');
    expect(res.text).toContain('Zahlungsziel');
    expect(fs.existsSync(path.join(dir, 'tessdata', 'deu.traineddata.gz'))).toBe(true);
  }, 120_000);

  it('reads scanned PDFs without a text layer via OCR', async () => {
    const res = await parseDocument(pdf, opts());
    expect(res.error).toBeNull();
    expect(res.text).toContain('Rechnung');
    expect(res.meta.ocr).toBe(true);
  }, 120_000);

  it('clearly reports that nothing was recognised when OCR is disabled', async () => {
    const res = await parseDocument(png, { ...opts(), ocrEnabled: false });
    expect(res.status).toBe('partial');
    expect(res.error).toMatch(/OCR/);
  });

  it('reads the scanned pages of a PDF that also has text pages (#226)', async () => {
    const file = writePdf('mixed.pdf', [{ text: 'Begleitschreiben Vertrag Hauskauf' }, { jpeg: scan }, { text: 'Anlage Kaufpreis 450000 Euro' }]);
    const res = await parseDocument(file, opts());
    expect(res.error).toBeNull();
    expect(res.text).toContain('Begleitschreiben');
    expect(res.text).toContain('Rechnung 4711');
    expect(res.text).toContain('Kaufpreis');
    expect(res.meta.ocr).toBe(true);
    expect(res.meta.ocrPagesSkipped).toBeUndefined();
    expect(res.truncated).toBe(false);
  }, 120_000);

  it('does not start OCR for a PDF whose pages all have text', async () => {
    const res = await parseDocument(writePdf('text-only.pdf', [{ text: 'Erste Seite mit genug Text' }, { text: 'Zweite Seite mit genug Text' }]), opts());
    expect(res.meta.ocr).toBeUndefined();
    expect(res.truncated).toBe(false);
  });

  it('records the scanned pages beyond the OCR page limit and marks the text as truncated (#226)', async () => {
    const file = writePdf('long-scan.pdf', [{ jpeg: scan }, { jpeg: scan }, { jpeg: scan }, { jpeg: scan }]);
    const res = await parseDocument(file, { ...opts(), maxOcrPages: 2 });
    expect(res.text.match(/Rechnung 4711/g)).toHaveLength(2);
    expect(res.meta.ocrPagesSkipped).toBe(2);
    expect(res.truncated).toBe(true);
  }, 120_000);

  it('reports an OCR failure instead of silently keeping the text layer only', async () => {
    const file = writePdf('broken-ocr.pdf', [{ text: 'Seite mit genug Text zum Lesen' }, { jpeg: scan }]);
    const res = await parseDocument(file, { ...opts(), ocrLanguages: 'xyz' });
    expect(res.status).toBe('partial');
    expect(res.error).toMatch(/OCR fehlgeschlagen/);
    expect(res.text).toContain('genug Text');
  });
});
