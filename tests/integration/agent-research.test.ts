import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool, ToolContext, ToolOutput } from '../../packages/core/src/agent/registry';
import type { ToolDeps } from '../../packages/core/src/agent/tools/common';
import { researchTools } from '../../packages/core/src/agent/tools/research';
import { documents } from '../../packages/core/src/db/schema';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';
import { emptyToolContext } from '../helpers/agent';

let app: TestApp;
let tools: Map<string, AgentTool>;
let ctx: ToolContext;

function depsOf(t: TestApp): ToolDeps {
  const s = t.services;
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
    enqueueConsistency: () => undefined,
    logger: s.ctx.logger,
  };
}

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  tools = new Map(researchTools(depsOf(app)).map((t) => [t.name, t]));
  ctx = emptyToolContext();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.cleanup();
});

async function call(name: string, args: unknown): Promise<ToolOutput> {
  const tool = tools.get(name)!;
  return tool.run(tool.schema.parse(args), ctx);
}

/** Imports a text file and archives it into `loc`. */
async function archived(
  name: string,
  content: string,
  opts: { loc?: string; date?: string | null; docType?: string; persons?: string[]; title?: string } = {},
): Promise<string> {
  const loc = opts.loc ?? 'private/finanzen';
  app.llm.on('DocumentClassification', () =>
    classification({
      title: opts.title ?? name.replace(/\.\w+$/, ''),
      summary: `Zusammenfassung ${name}`,
      categoryPath: loc,
      docType: opts.docType ?? 'Rechnung',
      persons: opts.persons ?? [],
      documentDate: opts.date ?? null,
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
  return id;
}

/** Makes a document non-shareable: mode „vorher fragen“ and the document not released for external analysis. */
function lockDocument(id: string) {
  app.services.settings.update({ privacy: { llmMode: 'confirm' } });
  app.services.database.db.update(documents).set({ llmStatus: 'pending' }).where(eq(documents.id, id)).run();
}

describe('agent research tools', () => {
  it('sums invoice totals deterministically with a list of receipts', async () => {
    const a = await archived('rechnung-a.txt', 'Rechnung\nPosition 1 100,00 €\nGesamtbetrag 119,00 €', { date: '2026-03-01' });
    const b = await archived('rechnung-b.txt', 'Invoice\nSubtotal 1,000.00 EUR\nTotal: 1,190.00 EUR', { date: '2026-04-01' });
    const c = await archived('rechnung-c.txt', 'Quittung über EUR 25,56', { date: '2026-05-01' });
    const none = await archived('brief.txt', 'Ein Brief ohne Beträge.', { date: '2026-05-02', docType: 'Brief' });
    const set = ctx.refs.set([a, b, c, none]);

    const out = await call('sum_amounts', { documents: [set] });

    expect(out.summary).toBe('Summe 1.334,56 € aus 3 Belegen');
    expect(out.content).toContain('SUMME: 1.334,56 €');
    expect(out.content).toContain('Betrag: 119,00 €');
    expect(out.content).toContain('<<<DOKUMENTINHALT');
    expect(out.content).toContain('Gesamtbetrag 119,00 €');
    expect(out.content).toContain(`Ohne erkennbaren Betrag: ${ctx.refs.doc(none)}`);
    expect(ctx.shared.has(a)).toBe(true);
  });

  it('skips documents that are not released and never shows their title', async () => {
    const a = await archived('rechnung-offen.txt', 'Gesamt 50,00 €', { date: '2026-03-01' });
    const secret = await archived('geheime-rechnung.txt', 'Gesamt 70,00 €', { date: '2026-03-02', title: 'Geheime Arztrechnung' });
    lockDocument(secret);
    app.services.database.db.update(documents).set({ llmStatus: 'analyzed' }).where(eq(documents.id, a)).run();

    const out = await call('sum_amounts', { documents: [ctx.refs.set([a, secret])] });

    expect(out.summary).toBe('Summe 50,00 € aus 1 Beleg');
    expect(out.content).toContain('1 nicht freigegebene Dokumente übersprungen');
    expect(out.content).not.toContain('Geheime Arztrechnung');
    expect(ctx.shared.has(secret)).toBe(false);
  });

  it('finds a missing month and a missing number in a series', async () => {
    const ids = [];
    for (const [n, m] of [
      [1, '01'],
      [2, '02'],
      [4, '04'],
      [5, '05'],
    ] as const)
      ids.push(await archived(`Kontoauszug Nr. ${n}.txt`, `Kontoauszug ${n} vom 2026-${m}`, { date: `2026-${m}-28`, docType: 'Kontoauszug' }));
    const set = ctx.refs.set(ids);

    const byMonth = await call('find_gaps', { documents: [set], by: 'month' });
    expect(byMonth.content).toContain('Fehlende Monate: 2026-03');
    expect(byMonth.summary).toBe('1 Monat(e) fehlen');
    expect(byMonth.content).toMatch(new RegExp(`Fundstelle <<<DOKUMENTINHALT quelle="${ctx.refs.doc(ids[0]!)}"\\nKontoauszug 1 vom 2026-01`));
    expect(byMonth.content).toContain(`quelle="${ctx.refs.doc(ids.at(-1)!)}"`);

    const byNumber = await call('find_gaps', { documents: [set], by: 'number' });
    expect(byNumber.content).toContain('fehlend 3');
    expect(byNumber.content).toMatch(new RegExp(`Fundstelle <<<DOKUMENTINHALT quelle="${ctx.refs.doc(ids[0]!)}"\\nKontoauszug Nr. 1\\n`));
  });

  it('compares contract versions as a table of changed lines', async () => {
    const a = await archived('vertrag-alt.txt', 'Mietvertrag\nMiete 800 €\nLaufzeit unbefristet\nKaution 2400 €', { docType: 'Vertrag' });
    const b = await archived('vertrag-neu.txt', 'Mietvertrag\nMiete 850 €\nLaufzeit unbefristet\nHaustiere erlaubt', { docType: 'Vertrag' });

    const out = await call('compare_documents', { a: ctx.refs.doc(a), b: ctx.refs.doc(b) });

    expect(out.summary).toBe('2 geändert, 0 nur in A, 0 nur in B');
    expect(out.content).toContain('| In A (alt) | In B (neu) | Änderung |');
    expect(out.content).toContain('| Miete 800 € | Miete 850 € | Miete 800 € → 850 € |');
    expect(out.content).toContain('| Kaution 2400 € | Haustiere erlaubt |');
    expect(out.content).toContain(`quelle="${ctx.refs.doc(a)}-${ctx.refs.doc(b)}-geändert"`);
  });

  it('lists lines without a counterpart and compares the first document with each further one', async () => {
    const a = await archived('v1.txt', 'Vertrag\nMiete 800 €\nAlte Klausel', { docType: 'Vertrag' });
    const b = await archived('v2.txt', 'Vertrag\nMiete 850 €', { docType: 'Vertrag' });
    const c = await archived('v3.txt', 'Vertrag\nMiete 800 €\nAlte Klausel\nNeue Klausel', { docType: 'Vertrag' });

    const out = await call('compare_documents', { a: ctx.refs.doc(a), b: ctx.refs.doc(b), weitere: [ctx.refs.doc(c)] });

    expect(out.content).toContain('B1 = ');
    expect(out.content).toContain('B2 = ');
    expect(out.content).toMatch(/Nur in A:\n<<<DOKUMENTINHALT[^\n]*\nAlte Klausel/);
    expect(out.content).toMatch(/Nur in B2:\n<<<DOKUMENTINHALT[^\n]*\nNeue Klausel/);
    expect(out.summary).toBe('1 geändert, 1 nur in A, 1 nur in B');
  });

  it('refuses to compare when one of the documents is not released', async () => {
    const a = await archived('offen.txt', 'Text A', { docType: 'Vertrag' });
    const b = await archived('gesperrt.txt', 'Text B', { docType: 'Vertrag' });
    lockDocument(b);

    const out = await call('compare_documents', { a: ctx.refs.doc(a), b: ctx.refs.doc(b) });

    expect(out.isError).toBe(true);
    expect(out.content).toContain('nicht zur Übertragung freigegeben');
  });

  it('finds deadlines with computation path and notices an existing reminder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T10:00:00'));
    const contract = await archived('handyvertrag.txt', 'Mobilfunkvertrag\nVertragsende: 31.12.2026\nKündigungsfrist 3 Monate zum Vertragsende.', {
      date: '2024-12-01',
      docType: 'Vertrag',
    });
    const id = await archived('ausweis.txt', 'Personalausweis\nGültig bis 14.02.2031', { docType: 'Ausweis', title: 'Ausweis Kopie Max' });
    app.services.reminders.create({ targetType: 'document', targetId: contract, title: 'Handy kündigen', remindAt: '2026-09-30T09:00:00.000Z' });
    lockDocument(id);
    app.services.database.db.update(documents).set({ llmStatus: 'analyzed' }).where(eq(documents.id, contract)).run();

    const out = await call('find_deadlines', { documents: [ctx.refs.doc(contract), ctx.refs.doc(id)] });

    expect(out.content).toContain('Kündigungsfrist: 2026-09-30');
    expect(out.content).toContain('Rechenweg: Vertragsende 31.12.2026 − 3 Monate = 30.09.2026');
    expect(out.content).toMatch(/Kündigungsfrist: 2026-09-30 \(Art: kuendigung\) \| Erinnerung vorhanden \(2026-09-30\)/);
    expect(out.content).toContain(`1 nicht freigegebene Dokumente übersprungen (nicht geprüft): ${ctx.refs.doc(id)}.`);
    for (const leak of ['Ausweis Kopie Max', 'Gültig bis', '2031']) expect(out.content).not.toContain(leak);
  });

  it('reports secrets only by kind and count', async () => {
    const id = await archived('zugang.txt', 'Router\nBenutzername: admin\nPasswort: SuperGeheim99\nPIN: 4711', { docType: 'Notiz' });
    await archived('harmlos.txt', 'Einkaufsliste: Milch, Brot', { docType: 'Notiz' });

    const out = await call('find_secrets', {});

    expect(out.content).toContain(ctx.refs.doc(id));
    expect(out.content).toMatch(/1× Passwort\/Schlüssel/);
    expect(out.content).toContain('exclude_from_llm');
    expect(out.content).not.toContain('SuperGeheim99');
    expect(out.content).not.toContain('4711');
    expect(out.summary).toBe('1 Dokument(e) mit möglichen Geheimnissen');
  });

  it('matches invoices with statement lines', async () => {
    const inv = await archived('rechnung-huber.txt', 'Elektro Huber\nRechnungsnummer: RE-2026-0042\nGesamtbetrag 1.190,00 €', { date: '2026-07-01' });
    const open = await archived('rechnung-maler.txt', 'Maler Schmidt\nRechnungsbetrag 300,00 €', { date: '2026-07-02' });
    const st = await archived('auszug-juli.txt', 'Kontoauszug Juli\n20.07.2026 Elektro Huber RE-2026-0042 -1.190,00\n22.07.2026 Bäckerei -12,40', {
      date: '2026-07-31',
      docType: 'Kontoauszug',
    });

    const out = await call('match_payments', { statements: [ctx.refs.doc(st)], invoices: [ctx.refs.doc(inv), ctx.refs.doc(open)] });

    expect(out.summary).toBe('1 bezahlt, 1 offen');
    expect(out.content).toMatch(/Bezahlt \(1\):\n- D\d+: „rechnung-huber“[^\n]*\n {2}Zahlung \(Rechnungsnummer im Text\)/);
    expect(out.content).toMatch(/Offen \(1\):\n- D\d+: „rechnung-maler“/);
    expect(out.content).toContain('Zahlungen ohne Rechnung (1)');
  });

  it('groups mails to threads, reports storage and finds filing examples', async () => {
    const mail = (subject: string, date: string) =>
      `From: a@example.test\nTo: b@example.test\nSubject: ${subject}\nDate: ${date}\nContent-Type: text/plain\n\nText zu ${subject}\n`;
    await archived('m1.eml', mail('Angebot Küche', 'Mon, 02 Mar 2026 10:00:00 +0000'), { docType: 'E-Mail', title: 'Angebot Küche' });
    await archived('m2.eml', mail('AW: Angebot Küche', 'Tue, 03 Mar 2026 10:00:00 +0000'), { docType: 'E-Mail', title: 'AW: Angebot Küche' });
    await archived('m3.eml', mail('Urlaub', 'Wed, 04 Mar 2026 10:00:00 +0000'), { docType: 'E-Mail', title: 'Urlaub' });
    const threads = await call('email_threads', {});
    expect(threads.summary).toBe('1 Verläufe');
    expect(threads.content).toContain('Verlauf „angebot küche“ (2 Nachrichten');

    const storage = await call('storage_report', {});
    expect(storage.content).toContain('Größte Dateien:');
    expect(storage.content).toContain('Keine exakten Duplikate.');

    const target = await archived('Stromrechnung März.txt', 'Gesamt 80,00 €', { loc: 'private/finanzen/strom', persons: ['Stadtwerke'] });
    await archived('Stromrechnung Februar.txt', 'Gesamt 75,00 €', { loc: 'private/finanzen/strom', persons: ['Stadtwerke'] });
    const examples = await call('similar_filings', { document: ctx.refs.doc(target) });
    expect(examples.content).toContain('BEISPIELE (keine Regel)');
    expect(examples.content).toContain('Ordner private/finanzen/strom');
  });

  it('lists problem files with an explanation', async () => {
    const id = await archived('leer.pdf', '%PDF-1.4\n%%EOF\n', { docType: 'Scan' });
    app.services.database.db.update(documents).set({ extractedText: '', processingError: null }).where(eq(documents.id, id)).run();

    const out = await call('problem_files', {});

    expect(out.content).toContain(ctx.refs.doc(id));
    expect(out.content).toContain('Kein Text erkannt');
  });
});
