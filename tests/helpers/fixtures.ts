import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';

export async function makeDocx(file: string, paragraphs: string[]): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

export async function makePptx(file: string, slides: string[]): Promise<void> {
  const zip = new JSZip();
  slides.forEach((s, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  });
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

export async function makeXlsx(file: string, rows: (string | number)[][]): Promise<void> {
  const zip = new JSZip();
  const strings: string[] = [];
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
          strings.push(v);
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

export function makeEml(file: string, subject: string, body: string): void {
  fs.writeFileSync(
    file,
    `From: Anna <anna@example.com>\r\nTo: Ben <ben@example.com>\r\nSubject: ${subject}\r\nDate: Mon, 01 Jun 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  );
}

export async function makePng(file: string): Promise<void> {
  await sharp({ create: { width: 32, height: 16, channels: 3, background: '#336699' } })
    .png()
    .toFile(file);
}

/** Minimales einseitiges PDF mit Text (Helvetica). */
export function makePdf(file: string, lines: string[]): void {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 12 Tf 50 750 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(file, out, 'latin1');
}

export function writeFile(dir: string, name: string, content: string | Buffer): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
