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

describe('Dokumentparser', () => {
  it('liest TXT und Markdown inkl. Umlaute', async () => {
    const f = writeFile(dir, 'notiz.md', '# Überschrift\n\nWir entscheiden uns für Variante A.');
    const r = await parseDocument(f);
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Überschrift');
  });

  it('liest PDF-Text', async () => {
    const f = path.join(dir, 'a.pdf');
    makePdf(f, ['Vertrag Hauskauf Musterstrasse', 'Kaufpreis 450000 Euro']);
    const r = await parseDocument(f);
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Vertrag Hauskauf');
    expect(r.meta.pages).toBe(1);
  });

  it('liest DOCX, PPTX, XLSX und EML', async () => {
    const docx = path.join(dir, 'a.docx');
    await makeDocx(docx, ['Protokoll Jour Fixe', 'Beschluss: Budget freigegeben']);
    expect((await parseDocument(docx)).text).toContain('Budget freigegeben');

    const pptx = path.join(dir, 'a.pptx');
    await makePptx(pptx, ['Roadmap 2026', 'Meilenstein Q3']);
    const p = await parseDocument(pptx);
    expect(p.text).toContain('Folie 2');
    expect(p.text).toContain('Meilenstein Q3');

    const xlsx = path.join(dir, 'a.xlsx');
    makeXlsx(xlsx, [['Posten', 'Betrag'], ['Miete', 1200]]);
    expect((await parseDocument(xlsx)).text).toContain('Miete');

    const eml = path.join(dir, 'a.eml');
    makeEml(eml, 'Urlaubsantrag', 'Bitte genehmigen.');
    const e = await parseDocument(eml);
    expect(e.text).toContain('Betreff: Urlaubsantrag');
    expect(e.text).toContain('Bitte genehmigen');
  });

  it('archiviert Bilder mit technischen Metadaten und markiert sie als partiell', async () => {
    const png = path.join(dir, 'a.png');
    await makePng(png);
    const r = await parseDocument(png);
    expect(r.status).toBe('partial');
    expect(r.meta.width).toBe(32);
  });

  it('wirft nicht bei defekten Dateien, sondern meldet den Status', async () => {
    const f = writeFile(dir, 'kaputt.pdf', 'kein pdf');
    const r = await parseDocument(f);
    expect(['failed', 'partial']).toContain(r.status);
    expect(r.error).toBeTruthy();
    const u = await parseDocument(writeFile(dir, 'x.bin', 'abc'));
    expect(u.status).toBe('unsupported');
  });
});
