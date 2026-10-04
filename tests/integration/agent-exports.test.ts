import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTool, ToolContext } from '../../packages/core/src/agent/registry';
import type { ToolDeps } from '../../packages/core/src/agent/tools/common';
import { exportTools } from '../../packages/core/src/agent/tools/exports';
import { csvCell } from '../../packages/core/src/agent/tools/exports/csv';
import { monthGaps } from '../../packages/core/src/agent/tools/exports/items';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';
import { emptyToolContext } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

function deps(): ToolDeps {
  const s = app.services;
  return {
    paths: s.paths,
    settings: s.settings,
    docs: s.documents,
    search: s.search,
    graph: s.graph,
    privacy: s.privacy,
    decisions: s.decisions,
    openItems: s.openItems,
    reminders: s.reminders,
    events: s.eventRecords,
    notes: s.notes,
    timeline: s.timeline,
    insights: s.insights,
    actions: s.actions,
    archive: s.archive,
    categories: s.categories,
    scanner: s.scanner,
    jobs: s.jobs,
    audit: s.audit,
    undo: s.undo,
    persons: s.persons,
    notifications: s.notifications,
    openItemDuplicates: s.openItemDuplicates,
    noteEventDuplicates: s.noteEventDuplicates,
    memory: {} as never,
    fileJobs: s.agentFileJobs,
    links: s.links,
    subjects: s.subjects,
    cases: s.cases,
    linkThresholds: s.linkThresholds,
    capture: s.capture,
    answers: s.answers,
    logs: s.logReader,
    diagnostics: s.diagnostics,
    enqueueConsistency: () => undefined,
    logger: s.ctx.logger,
  };
}

const tool = (name: string): AgentTool => {
  const t = exportTools(deps()).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const run = (name: string, args: unknown, ctx: ToolContext) => {
  const t = tool(name);
  return t.run(t.schema.parse(args), ctx);
};

/** Imports a file and archives it (copy) into `loc` with the given title and document date. */
async function archived(name: string, content: string | Buffer, loc: string, title: string, date: string): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({
      title,
      summary: `Zusammenfassung ${title}`,
      categoryPath: loc,
      docType: 'Rechnung',
      dates: [{ date, kind: 'document_date', label: 'Rechnungsdatum' }],
    }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic: null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  // the business date does not depend on what the fake classification returns
  app.services.database.sqlite.prepare('UPDATE documents SET document_date = ? WHERE id = ?').run(date, id);
  return id;
}

async function makePdf(pages: number, text: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) pdf.addPage([300, 300]).drawText(`${text} Seite ${i + 1}`, { x: 20, y: 150, size: 12, font });
  return Buffer.from(await pdf.save());
}

const abs = (id: string) => path.join(app.services.settings.get().archiveRoot, ...app.services.documents.getRow(id).archiveRelPath!.split('/'));

async function setup() {
  const a = await archived('strom-jan.txt', 'Stromrechnung Januar\nGesamtbetrag: 1.234,56 €\n', 'Privat/finanzen/strom', 'Strom Januar', '2026-01-15');
  const b = await archived('strom-apr.txt', 'Stromrechnung April\nZu zahlender Betrag 100,44 EUR\n', 'Privat/finanzen/strom', 'Strom April', '2026-04-10');
  const c = await archived('vertrag.pdf', await makePdf(2, 'Vertrag'), 'Privat/finanzen/vertrag', 'Stromvertrag', '2026-02-01');
  const ctx = emptyToolContext();
  const refs = [a, b, c].map((id) => ctx.refs.doc(id));
  const before = [a, b, c].map((id) => fs.readFileSync(abs(id)));
  return { ids: [a, b, c], ctx, refs, before };
}

describe('agent export tools (#311)', () => {
  it('finds month gaps and escapes CSV cells', () => {
    expect(monthGaps(['2026-01-15', '2026-04-10', '2026-02-01'])).toEqual(['2026-03']);
    expect(monthGaps(['2025-11-01', '2026-02-01'])).toEqual(['2025-12', '2026-01']);
    expect(csvCell('Rechnung "Mai"; Teil 1')).toBe('"Rechnung ""Mai""; Teil 1"');
    expect(csvCell('einfach')).toBe('einfach');
  });

  it('bundles documents as ZIP with overview, sum and gaps; the archive stays unchanged', async () => {
    const { ids, ctx, refs, before } = await setup();
    const out = await run('export_bundle', { documents: refs, format: 'zip', title: 'Strom 2026' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.change).toBe('Mappe „Strom 2026“ erstellt (3 Dokumente)');
    expect(ctx.files).toHaveLength(1);
    const file = ctx.files[0]!;
    expect(path.dirname(file)).toBe(path.join(app.services.paths.root, 'exports'));
    expect(path.basename(file)).toMatch(/^Strom 2026 \d{4}-\d{2}-\d{2}\.zip$/);
    expect(out.content).toContain('1.335,00 €');

    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const names = Object.keys(zip.files).toSorted();
    expect(names).toEqual(['strom-apr.txt', 'strom-jan.txt', 'vertrag.pdf', 'Übersicht.csv', 'Übersicht.md'].toSorted());
    expect(await zip.file('strom-jan.txt')!.async('string')).toContain('1.234,56');
    const md = await zip.file('Übersicht.md')!.async('string');
    expect(md).toContain('# Strom 2026');
    const rows = md.split('\n').filter((l) => /^\| 2026-/.test(l));
    expect(rows.map((r) => r.split(' | ')[1])).toEqual(['Strom Januar', 'Stromvertrag', 'Strom April']);
    expect(md).toContain('1.234,56 €');
    expect(md).toContain('**Summe: 1.335,00 €**');
    expect(md).toContain('Monate ohne Dokument: 2026-03');
    const csv = await zip.file('Übersicht.csv')!.async('string');
    expect(csv).toContain('Summe;;;1335,00');

    // a second export with the same title does not overwrite
    await run('export_bundle', { documents: refs, format: 'zip', title: 'Strom 2026', overview: false }, ctx);
    expect(ctx.files).toHaveLength(2);
    expect(path.basename(ctx.files[1]!)).toMatch(/\(2\)\.zip$/);
    expect(fs.existsSync(ctx.files[0]!)).toBe(true);

    ids.forEach((id, i) => expect(fs.readFileSync(abs(id)).equals(before[i]!)).toBe(true));
  });

  it('bundles as one PDF: overview pages + all PDF pages, non-PDFs only listed; saveAsCase links the documents', async () => {
    const { ids, ctx, refs } = await setup();
    const out = await run('export_bundle', { documents: refs, format: 'pdf', title: 'Strom 2026', saveAsCase: 'Stromwechsel 2026' }, ctx);
    expect(out.isError).toBeFalsy();
    const pdf = await PDFDocument.load(fs.readFileSync(ctx.files[0]!));
    expect(out.content).toMatch(/1 Übersichtsseite\(n\), 1 PDF-Dokument\(e\) mit 2 Seite\(n\)/);
    expect(pdf.getPageCount()).toBe(1 + 2);
    expect(out.content).toContain('Nicht eingebunden');

    const c = app.services.graph.findByName('case', 'Stromwechsel 2026');
    expect(c).toBeTruthy();
    for (const id of ids) {
      const rel = app.services.graph.relationsOf(id, { types: ['belongs_to'] }).find((r) => r.targetEntityId === c!.id);
      expect(rel?.status).toBe('confirmed');
    }
    expect(ctx.changes.some((x) => x.includes('Stromwechsel 2026'))).toBe(true);
  });

  it('exports CSV for Excel (BOM, semicolons, escaped quotes)', async () => {
    const { ctx, refs } = await setup();
    const out = await run('export_csv', { documents: refs, columns: ['datum', 'titel', 'betrag', 'ordner'] }, ctx);
    expect(out.isError).toBeFalsy();
    const csv = fs.readFileSync(ctx.files[0]!, 'utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toEqual([
      'Datum;Titel;Betrag;Ordner',
      '2026-01-15;Strom Januar;1234,56;Privat/finanzen/strom',
      '2026-02-01;Stromvertrag;;Privat/finanzen/vertrag',
      '2026-04-10;Strom April;100,44;Privat/finanzen/strom',
    ]);
    expect(out.content).toContain('3 Zeile(n)');
  });

  it('exports the invoice total, not a subtotal, and no amount for a document without a total line', async () => {
    const contract = await archived('miete.txt', 'Mietvertrag\nKaution 2.550,00 €\nMiete 850,00 € monatlich\n', 'Privat/wohnen', 'Mietvertrag', '2026-03-01');
    const id = await archived(
      'maler.txt',
      'Rechnung Malerarbeiten\nZwischensumme 100,00 €\nMwSt 19 % 19,00 €\nRechnungsbetrag 119,00 €\n',
      'Privat/finanzen/haus',
      'Maler',
      '2026-03-02',
    );
    const ctx = emptyToolContext();
    await run('export_csv', { documents: [ctx.refs.doc(contract), ctx.refs.doc(id)], columns: ['titel', 'betrag'] }, ctx);
    const lines = fs.readFileSync(ctx.files[0]!, 'utf8').slice(1).trimEnd().split('\r\n');
    expect(lines).toEqual(['Titel;Betrag', 'Mietvertrag;', 'Maler;119,00']);
  });

  it('keeps titles of non-shareable documents out of the tool result (the local file is complete)', async () => {
    const { ids, ctx, refs } = await setup();
    app.services.documents.setLlmExcluded(ids[0]!, { excluded: true });
    fs.rmSync(abs(ids[0]!));
    for (const p of [app.services.documents.getRow(ids[0]!).sourcePath, app.services.documents.getRow(ids[0]!).stagedPath])
      if (p) fs.rmSync(p, { force: true });
    const out = await run('export_bundle', { documents: refs, format: 'zip', title: 'Strom privat' }, ctx);
    expect(out.content).toContain('[nicht freigegeben]');
    expect(out.content).not.toContain('Strom Januar');
    expect(out.content).not.toContain('1.335,00');
    expect(out.change).toBe('Mappe „Strom privat“ erstellt (2 Dokumente)');
    const csvOut = await run('export_csv', { documents: refs }, ctx);
    expect(csvOut.content).toContain('1 Zeile(n) betreffen nicht freigegebene Dokumente');
    expect(csvOut.content).not.toContain('Strom Januar');
    expect(fs.readFileSync(ctx.files[1]!, 'utf8')).toContain('Strom Januar');
  });

  it('writes reports as Markdown and PDF', async () => {
    const ctx = emptyToolContext();
    const md = '## Ergebnis\n\nStrom kostete „1.335,00 €“ – siehe D1.\n\n- Punkt eins\n- Punkt ✓ zwei';
    await run('write_report', { title: 'Stromkosten', markdown: md, format: 'md' }, ctx);
    expect(fs.readFileSync(ctx.files[0]!, 'utf8')).toBe(`# Stromkosten\n\n${md}\n`);
    await run('write_report', { title: 'Stromkosten', markdown: `${md}\n${'Langer Text. '.repeat(1500)}`, format: 'pdf' }, ctx);
    const pdf = await PDFDocument.load(fs.readFileSync(ctx.files[1]!));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it('draft_reply stores a note linked to the document and a local file, never sends', async () => {
    const { ids, ctx, refs } = await setup();
    const out = await run('draft_reply', { document: refs[0], text: 'Sehr geehrte Damen und Herren,\nich widerspreche der Rechnung.' }, ctx);
    expect(out.content).toContain('nichts versendet');
    const note = app.services.graph.findByName('note', 'Antwortentwurf: Strom Januar');
    expect(note).toBeTruthy();
    const rel = app.services.graph.relationsOf(note!.id, { types: ['relates_to'] }).find((r) => r.targetEntityId === ids[0]);
    expect(rel).toBeTruthy();
    expect(ctx.files).toHaveLength(1);
    expect(fs.readFileSync(ctx.files[0]!, 'utf8')).toContain('ich widerspreche der Rechnung.');
  });
});
