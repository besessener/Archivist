import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '../../packages/core/src/parsers';
import { makeDocx, makeEml, makePdf, makePng, makePptx, makeXlsx, writeFile } from '../helpers/fixtures';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-parsers-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('document parsers', () => {
  it('reads TXT and Markdown including umlauts', async () => {
    const f = writeFile(dir, 'notiz.md', '# Überschrift\n\nWir entscheiden uns für Variante A.');
    const r = await parseDocument(f);
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Überschrift');
  });

  it('trims trailing whitespace in linear time, even with very long runs of spaces', async () => {
    const f = writeFile(dir, 'blanks.txt', `Zeile eins  \t \r\nZeile zwei\n\n\n\n\n\nEnde${' '.repeat(300_000)}x`);
    const started = Date.now();
    const r = await parseDocument(f);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.text.startsWith('Zeile eins\nZeile zwei\n\n\nEnde')).toBe(true);
  });

  it('reads PDF text', async () => {
    const f = path.join(dir, 'a.pdf');
    makePdf(f, ['Vertrag Hauskauf Musterstrasse', 'Kaufpreis 450000 Euro']);
    const r = await parseDocument(f);
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Vertrag Hauskauf');
    expect(r.meta.pages).toBe(1);
  });

  it('reads DOCX, PPTX, XLSX and EML', async () => {
    const docx = path.join(dir, 'a.docx');
    await makeDocx(docx, ['Protokoll Jour Fixe', 'Beschluss: Budget freigegeben']);
    expect((await parseDocument(docx)).text).toContain('Budget freigegeben');

    const pptx = path.join(dir, 'a.pptx');
    await makePptx(pptx, ['Roadmap 2026', 'Meilenstein Q3']);
    const p = await parseDocument(pptx);
    expect(p.text).toContain('Folie 2');
    expect(p.text).toContain('Meilenstein Q3');

    const xlsx = path.join(dir, 'a.xlsx');
    await makeXlsx(xlsx, [
      ['Posten', 'Betrag'],
      ['Miete', 1200],
    ]);
    const x = await parseDocument(xlsx);
    expect(x.status).toBe('extracted');
    expect(x.text).toContain('Tabellenblatt „Budget“');
    expect(x.text).toContain('Miete | 1200');

    const eml = path.join(dir, 'a.eml');
    makeEml(eml, 'Urlaubsantrag', 'Bitte genehmigen.');
    const e = await parseDocument(eml);
    expect(e.text).toContain('Betreff: Urlaubsantrag');
    expect(e.text).toContain('Bitte genehmigen');
  });

  it('archives images with technical metadata and marks them as partial', async () => {
    const png = path.join(dir, 'a.png');
    await makePng(png);
    const r = await parseDocument(png);
    expect(r.status).toBe('partial');
    expect(r.meta.width).toBe(32);
  });

  it('does not throw on broken files but reports the status', async () => {
    const f = writeFile(dir, 'kaputt.pdf', 'kein pdf');
    const r = await parseDocument(f);
    expect(['failed', 'partial']).toContain(r.status);
    expect(r.error).toBeTruthy();
    const u = await parseDocument(writeFile(dir, 'x.bin', 'abc'));
    expect(u.status).toBe('unsupported');
  });
});
