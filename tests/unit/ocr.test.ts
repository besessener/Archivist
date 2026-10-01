import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '../../packages/core/src/parsers';

const TEXT = ['Rechnung 4711', 'Zahlungsziel 30 Tage', 'Archivist Testlauf'];
let dir: string;
let png: string;
let pdf: string;
const opts = () => ({ ocrEnabled: true, ocrLanguages: 'deu+eng', tessdataDir: path.join(dir, 'tessdata') });

/** Minimales PDF mit genau einem JPEG-Bild (kein Textlayer) – simuliert einen Scan. */
function imageOnlyPdf(jpeg: Buffer, w: number, h: number): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    len += buf.length;
  };
  const obj = (n: number, body: Buffer | string) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  obj(5, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream', 'latin1')]));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-ocr-'));
  const w = 1000;
  const h = 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/>${TEXT.map((t, i) => `<text x="40" y="${90 + i * 100}" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" fill="black">${t}</text>`).join('')}</svg>`;
  png = path.join(dir, 'scan.png');
  await sharp(Buffer.from(svg)).png().toFile(png);
  const jpeg = await sharp(png).grayscale().jpeg({ quality: 95 }).toBuffer();
  pdf = path.join(dir, 'scan.pdf');
  fs.writeFileSync(pdf, imageOnlyPdf(jpeg, w, h));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('OCR (offline, tesseract.js)', () => {
  it('erkennt Text in einem Bild', async () => {
    const res = await parseDocument(png, opts());
    expect(res.error).toBeNull();
    expect(res.status).toBe('extracted');
    expect(res.text).toContain('Rechnung');
    expect(res.text).toContain('4711');
    expect(res.text).toContain('Zahlungsziel');
    expect(fs.existsSync(path.join(dir, 'tessdata', 'deu.traineddata.gz'))).toBe(true);
  }, 120_000);

  it('liest gescannte PDFs ohne Textebene per OCR', async () => {
    const res = await parseDocument(pdf, opts());
    expect(res.error).toBeNull();
    expect(res.text).toContain('Rechnung');
    expect(res.meta.ocr).toBe(true);
  }, 120_000);

  it('meldet bei deaktivierter OCR verständlich, dass nichts erkannt wurde', async () => {
    const res = await parseDocument(png, { ...opts(), ocrEnabled: false });
    expect(res.status).toBe('partial');
    expect(res.error).toMatch(/OCR/);
  });
});
