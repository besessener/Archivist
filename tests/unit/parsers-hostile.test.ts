import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '../../packages/core/src/parsers';
import { elements, startTags } from '../../packages/core/src/parsers/xml-scan';
import { ZIP_LIMITS } from '../../packages/core/src/parsers/zip-read';
import { makeDocx, makePptx, makeXlsx } from '../helpers/fixtures';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-hostile-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const zipFile = async (name: string, parts: Record<string, string | Buffer>): Promise<string> => {
  const zip = new JSZip();
  for (const [part, content] of Object.entries(parts)) zip.file(part, content);
  const file = path.join(dir, name);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
};

const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
};

describe('XML scanning', () => {
  it('finds elements by exact name, self-closing tags and attributes', () => {
    const xml = '<a:pPr x="1"/><a:p a="1">eins</a:p><a:p/><a:p>zwei</a:p>';
    expect([...elements(xml, 'a:p')]).toEqual([
      { attributes: ' a="1"', body: 'eins' },
      { attributes: '', body: '' },
      { attributes: '', body: 'zwei' },
    ]);
    expect([...startTags('<sheet name="A"/><sheetPr/><sheet name="B"></sheet>', 'sheet')]).toEqual([' name="A"', ' name="B"']);
  });

  it('stops at an unterminated tag instead of rescanning', () => {
    expect([...elements('<c r="A1">offen', 'c')]).toEqual([]);
    expect([...elements('<c r="A1"', 'c')]).toEqual([]);
  });
});

describe('crafted Office files (#205)', () => {
  it('reads a PPTX with 200,000 unterminated paragraph tags in linear time', async () => {
    const slide = `<p:sld><a:p><a:r><a:t>Echter Text</a:t></a:r></a:p>${'<a:p '.repeat(200_000)}</p:sld>`;
    const file = await zipFile('hostile.pptx', { 'ppt/slides/slide1.xml': slide });
    const { value, ms } = await timed(() => parseDocument(file));
    expect(ms).toBeLessThan(3_000);
    expect(value.text).toContain('Echter Text');
  });

  it('reads an XLSX with 200,000 unterminated cell and text tags in linear time', async () => {
    const parts = {
      'xl/workbook.xml': '<workbook><sheets><sheet name="Blatt" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Wert</t></is></c>${'<c '.repeat(200_000)}</row></sheetData></worksheet>`,
    };
    const file = await zipFile('hostile.xlsx', parts);
    const { value, ms } = await timed(() => parseDocument(file));
    expect(ms).toBeLessThan(3_000);
    expect(value.text).toContain('Wert');
  });

  it('keeps reading regular Office files as before', async () => {
    const pptx = path.join(dir, 'ok.pptx');
    await makePptx(pptx, ['Roadmap']);
    expect((await parseDocument(pptx)).text).toContain('Roadmap');
    const xlsx = path.join(dir, 'ok.xlsx');
    await makeXlsx(xlsx, [['Posten', 'Betrag']]);
    expect((await parseDocument(xlsx)).text).toContain('Posten | Betrag');
  });

  it('strips a huge style block from an HTML mail in linear time (html-text.ts)', async () => {
    const eml = path.join(dir, 'style.eml');
    fs.writeFileSync(
      eml,
      `From: a@example.org\nTo: b@example.org\nSubject: Stil\nContent-Type: text/html; charset=utf-8\n\n<html><style>${'<s'.repeat(200_000)}</style><body>Sichtbar</body></html>`,
    );
    const { value, ms } = await timed(() => parseDocument(eml));
    expect(ms).toBeLessThan(3_000);
    expect(value.status).toBe('extracted');
  });
});

describe('ZIP bombs (#205)', () => {
  it('refuses a part that inflates beyond the per-part limit', async () => {
    const file = await zipFile('bomb.pptx', { 'ppt/slides/slide1.xml': Buffer.alloc(ZIP_LIMITS.maxEntryBytes + 1024 * 1024) });
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024);
    const result = await parseDocument(file);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/komprimiert/);
  }, 60_000);

  it('refuses a DOCX with a bomb in a part the text extraction does not read', async () => {
    const file = path.join(dir, 'bomb.docx');
    await makeDocx(file, ['Harmlos']);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    zip.file('word/media/payload.bin', Buffer.alloc(ZIP_LIMITS.maxEntryBytes + 1024 * 1024));
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const result = await parseDocument(file);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/komprimiert/);
  }, 60_000);

  it('refuses an archive with too many entries', async () => {
    const parts: Record<string, string> = {};
    for (let index = 0; index <= ZIP_LIMITS.maxEntries; index += 1) parts[`ppt/media/${index}.xml`] = '';
    const result = await parseDocument(await zipFile('many.pptx', parts));
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/zu viele Einträge/);
  }, 60_000);
});
