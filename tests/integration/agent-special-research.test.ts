import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolOutput } from '../../packages/core/src/agent/registry';
import { metadataTools } from '../../packages/core/src/agent/tools/metadata';
import { readTools } from '../../packages/core/src/agent/tools/read';
import { researchTools } from '../../packages/core/src/agent/tools/research';
import { specialTaskTools } from '../../packages/core/src/agent/tools/special-tasks';
import { documents } from '../../packages/core/src/db/schema';
import { emptyToolContext } from '../helpers/agent';
import { archiveFile, setExtractedText, toolCaller, toolDepsOf, uniqueImage, type ArchivedFile } from '../helpers/agent-tools';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
let ctx: ToolContext;
let call: (name: string, args: unknown) => Promise<ToolOutput>;

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  const deps = toolDepsOf(app);
  ctx = emptyToolContext();
  call = toolCaller([...researchTools(deps), ...specialTaskTools(deps), ...readTools(deps), ...metadataTools(deps)], ctx);
});
afterEach(async () => {
  await app.cleanup();
});

const archived = (name: string, content: string | Buffer, rest: Partial<ArchivedFile> = {}) => archiveFile(app, { name, content, ...rest });
const patch = (id: string, values: Partial<typeof documents.$inferInsert>) =>
  app.services.database.db.update(documents).set(values).where(eq(documents.id, id)).run();

/** Makes a document non-shareable: mode „vorher fragen“ and the document not released for external analysis. */
function lockDocument(id: string) {
  app.services.settings.update({ privacy: { llmMode: 'confirm' } });
  patch(id, { llmStatus: 'pending' });
}

describe('match_payments with other statement formats (#312)', () => {
  it('reads a CSV export and matches by amount alone, with point and comma decimals', async () => {
    const strom = await archived('rechnung-strom.txt', 'Stadtwerke\nGesamtbetrag 89,00 €', { date: '2026-07-01' });
    const gas = await archived('rechnung-gas.txt', 'Gaswerk\nGesamtbetrag 40,50 €', { date: '2026-07-02' });
    const offen = await archived('rechnung-maler.txt', 'Maler\nGesamtbetrag 300,00 €', { date: '2026-07-03' });
    const csv = ['Datum;Text;Betrag', '15.07.2026;Stadtwerke Abschlag;-89,00', '2026-07-16;Gaswerk;-40.50;EUR', '17.07.2026;Bäckerei;-12,40'].join('\n');
    const statement = await archived('auszug.csv.txt', csv, { date: '2026-07-31', docType: 'Kontoauszug' });

    const out = await call('match_payments', { statements: [ctx.refs.doc(statement)], invoices: [strom, gas, offen].map((id) => ctx.refs.doc(id)) });

    expect(out.summary).toBe('2 bezahlt, 1 offen');
    expect(out.content).toContain('3 Buchungen aus 1 Auszügen');
    expect(out.content).toMatch(/rechnung-strom[^\n]*\n {2}Zahlung \(gleicher Betrag\): <<<DOKUMENTINHALT[^\n]*\n2026-07-15 -89,00 € Stadtwerke Abschlag/);
    expect(out.content).toMatch(/rechnung-gas[^\n]*\n {2}Zahlung \(gleicher Betrag\): <<<DOKUMENTINHALT[^\n]*\n2026-07-16 -40,50 € Gaswerk/);
    expect(out.content).toMatch(/Offen \(1\):\n- D\d+: „rechnung-maler“/);
    expect(out.content).toContain('Zahlungen ohne Rechnung (1)');
    expect(out.content).not.toContain('Hinweis: In den Kontoauszügen');
  });

  it('says so when a statement has no readable booking instead of guessing', async () => {
    const inv = await archived('rechnung-a.txt', 'Gesamtbetrag 50,00 €', { date: '2026-07-01' });
    const statement = await archived('auszug-prosa.txt', 'Im Juli wurden einige Beträge abgebucht, Details siehe Online-Banking.', { docType: 'Kontoauszug' });

    const out = await call('match_payments', { statements: [ctx.refs.doc(statement)], invoices: [ctx.refs.doc(inv)] });

    expect(out.summary).toBe('0 bezahlt, 1 offen');
    expect(out.content).toContain('0 Buchungen aus 1 Auszügen');
    expect(out.content).toContain('keine Buchung erkannt');
    expect(out.content).toContain('Nichts raten');
  });
});

describe('match_receipt_photos (#312)', () => {
  it('proposes the invoice and its case for a receipt photo, with evidence lines as data', async () => {
    const invoice = await archived('rechnung-mediamarkt.txt', 'Media Markt GmbH\nRechnung Nr. 99\nGesamtbetrag 49,90 €', { date: '2026-03-12' });
    await archived('rechnung-anders.txt', 'Baumarkt\nGesamtbetrag 700,00 €', { date: '2026-03-13' });
    const kauf = (await app.ok('cases:create', { name: 'Kopfhörer Garantie' })).case;
    app.services.cases.assign({ entryIds: [invoice], caseId: kauf.id });
    const photo = await archived('kassenbon.png', await uniqueImage(), { docType: 'Beleg', title: 'Kassenbon' });
    setExtractedText(app, photo, 'Media Markt\nHauptstr. 5\nDatum 14.03.2026\nKopfhörer 49,90\nSumme 49,90 EUR');
    const noText = await archived('unleserlich.png', await uniqueImage(), { docType: 'Beleg' });
    setExtractedText(app, noText, '');

    const out = await call('match_receipt_photos', {});

    expect(out.summary).toBe('1 Belegfoto(s) geprüft');
    expect(out.content).toContain('1 ohne Text');
    expect(out.content).toContain('Erkannt: Betrag 49,90 € | Datum 2026-03-14 | Händler: Media Markt');
    expect(out.content).toMatch(/Fundstellen: <<<DOKUMENTINHALT quelle="Belegfoto D\d+"\nMedia Markt\nSumme 49,90 EUR\nDOKUMENTINHALT>>>/);
    expect(out.content).toMatch(/Wahrscheinlichster Beleg: D\d+: „rechnung-mediamarkt“[^\n]*\(gleicher Betrag, Datum 2 Tag\(e\) Abstand, Händler passt\)/);
    expect(out.content).toMatch(/Gleiche Zuordnung: Vorgang K\d+ „Kopfhörer Garantie“/);
    expect(out.content).toMatch(/add_to_case case=K\d+ entries=\[D\d+\]/);
    expect(out.content).not.toContain('rechnung-anders');
    expect(ctx.shared.has(invoice)).toBe(true);
  });

  it('names no partner when nothing fits, skips photos that are not released and reads only the given photos', async () => {
    await archived('rechnung-x.txt', 'Gesamtbetrag 10,00 €', { date: '2026-01-01' });
    const photo = await archived('bon.jpg', await uniqueImage('jpeg'), { docType: 'Beleg' });
    setExtractedText(app, photo, 'Kiosk\nSumme 3,20 EUR');
    const secret = await archived('geheim.png', await uniqueImage(), { docType: 'Beleg', title: 'Arztbeleg' });
    setExtractedText(app, secret, 'Praxis Dr. Müller\nSumme 80,00 EUR');
    lockDocument(secret);
    patch(photo, { llmStatus: 'analyzed' });

    const out = await call('match_receipt_photos', { documents: [ctx.refs.doc(photo), ctx.refs.doc(secret), 'D99'] });

    expect(out.content).toContain('Kein passender Beleg oder Vorgang gefunden.');
    expect(out.content).toContain('1 nicht freigegeben');
    expect(out.content).toContain('Unbekannte IDs: D99');
    expect(out.content).not.toContain('Arztbeleg');
  });

  it('suggests the topic and project of the partner when it has no case', async () => {
    const invoice = await archived('rechnung-bauhaus.txt', 'Bauhaus\nGesamtbetrag 25,00 €', { date: '2026-05-02' });
    app.services.documents.bulkUpdate([invoice], { patch: { topic: 'Garten', project: 'Beet' }, trigger: 'manual' });
    const photo = await archived('bauhaus.png', await uniqueImage(), { docType: 'Beleg' });
    setExtractedText(app, photo, 'Bauhaus\n02.05.2026\nGesamt 25,00 EUR');

    const out = await call('match_receipt_photos', { documents: [ctx.refs.doc(photo)] });

    expect(out.content).toContain('Gleiche Zuordnung: Thema „Garten“, Projekt „Beet“');
    expect(out.content).toMatch(/set_metadata targets=\[D\d+\] topic="Garten" project="Beet"/);
  });
});

describe('email_threads with headers (#312)', () => {
  const mail = (subject: string, date: string, headers: string[] = []) =>
    [
      'From: a@example.test',
      'To: b@example.test',
      `Subject: ${subject}`,
      `Date: ${date}`,
      ...headers,
      'Content-Type: text/plain',
      '',
      `Text zu ${subject}`,
      '',
    ].join('\n');

  it('keeps equal subjects of different threads apart and marks the basis', async () => {
    const eml = { docType: 'E-Mail', loc: 'Privat/post' };
    const on = (date: string) => ({ ...eml, date });
    const a1 = await archived('a1.eml', mail('Angebot Küche', 'Mon, 02 Mar 2026 10:00:00 +0000', ['Message-ID: <k1@x.test>']), {
      ...on('2026-03-02'),
      title: 'Angebot Küche',
    });
    const a2 = await archived(
      'a2.eml',
      mail('AW: Angebot Küche', 'Tue, 03 Mar 2026 10:00:00 +0000', ['Message-ID: <k2@x.test>', 'In-Reply-To: <k1@x.test>', 'References: <k1@x.test>']),
      { ...on('2026-03-03'), title: 'AW: Angebot Küche' },
    );
    const b1 = await archived('b1.eml', mail('Angebot Küche', 'Mon, 06 Apr 2026 10:00:00 +0000', ['Message-ID: <k3@x.test>']), {
      ...on('2026-04-06'),
      title: 'Angebot Küche',
    });
    const b2 = await archived('b2.eml', mail('Re: Angebot Küche', 'Tue, 07 Apr 2026 10:00:00 +0000', ['Message-ID: <k4@x.test>', 'In-Reply-To: <k3@x.test>']), {
      ...on('2026-04-07'),
      title: 'Re: Angebot Küche',
    });
    await archived('old1.eml', mail('Urlaub', 'Mon, 04 May 2026 10:00:00 +0000'), { ...eml, title: 'Urlaub' });
    await archived('old2.eml', mail('AW: Urlaub', 'Tue, 05 May 2026 10:00:00 +0000'), { ...eml, title: 'AW: Urlaub' });

    const out = await call('email_threads', {});

    expect(out.summary).toBe('3 Verläufe');
    const threads = out.content.split(/\n(?=Verlauf )/);
    const idsOf = (thread: string) => [...thread.matchAll(/- (D\d+):/g)].map((m) => m[1]);
    const ref = (id: string) => ctx.refs.doc(id);
    const headerThreads = threads.filter((t) => t.includes('nach Message-ID und Antwort-Kopfzeilen'));
    // each thread in the order of its dates; the two threads have the same subject and size, their order is not specified
    expect(headerThreads.map(idsOf)).toHaveLength(2);
    expect(headerThreads.map(idsOf)).toEqual(
      expect.arrayContaining([
        [ref(a1), ref(a2)],
        [ref(b1), ref(b2)],
      ]),
    );
    expect(threads.find((t) => t.includes('„urlaub“'))).toContain('nur nach Betreff, keine Kopfzeilen gespeichert – eine Vermutung');
  });
});

describe('problem_files branches (#312)', () => {
  it('explains encrypted, quarantined, failed, wrong-extension and text-less image files', async () => {
    const encrypted = await archived('geschuetzt.txt', 'x', { title: 'Geschützte Datei' });
    patch(encrypted, { status: 'failed', processingError: 'PDF ist passwortgeschützt' });
    const quarantined = await archived('verdaechtig.txt', 'y', { title: 'Verdächtige Datei' });
    patch(quarantined, { status: 'quarantined' });
    const failed = await archived('kaputt.txt', 'z', { title: 'Kaputte Datei' });
    patch(failed, { status: 'failed', processingError: 'Lesefehler bei Seite 3' });
    const wrong = await archived('falsch.txt', 'w', { title: 'Falsche Endung' });
    patch(wrong, { mime: 'application/pdf' });
    const image = await archived('scan.png', await uniqueImage(), { title: 'Scan ohne Text' });
    setExtractedText(app, image, '');
    const fine = await archived('gut.txt', 'Alles in Ordnung hier.', { title: 'Gute Datei' });

    const out = await call('problem_files', {});

    const section = (id: string) => out.content.split(/\n(?=- D)/).find((s) => s.startsWith(`- ${ctx.refs.doc(id)}:`)) ?? '';
    expect(out.summary).toBe('5 Problemdatei(en)');
    expect(section(encrypted)).toContain('vermutlich verschlüsselt bzw. passwortgeschützt');
    expect(section(quarantined)).toContain('In Quarantäne: Der Inhalt passt nicht zur Dateiendung.');
    expect(section(failed)).toContain('Verarbeitung fehlgeschlagen: Lesefehler bei Seite 3 – „Erneut verarbeiten“ versuchen.');
    expect(section(wrong)).toContain('Endung .txt passt nicht zum Dateityp (application/pdf).');
    expect(section(image)).toContain('Kein Text erkannt, obwohl der Dateityp lesbar ist');
    expect(out.content).not.toContain(ctx.refs.doc(fine));
  });

  it('names a problem file that is not released only by its type, folder and status', async () => {
    const id = await archived('geheim.txt', 'x', { title: 'Geheimer Arztbrief' });
    patch(id, { status: 'quarantined' });
    lockDocument(id);

    const out = await call('problem_files', {});

    expect(out.content).toContain('1 nicht freigegeben');
    expect(out.content).not.toContain('Geheimer Arztbrief');
  });

  it('reports no problems for a healthy archive', async () => {
    await archived('gut.txt', 'Alles in Ordnung hier.');
    expect((await call('problem_files', {})).summary).toBe('keine Probleme');
  });
});

describe('storage_report (#312)', () => {
  it('lists duplicate groups with the wasted space and says the unused list is an approximation', async () => {
    const original = await archived('vertrag.txt', 'Mietvertrag Text', { title: 'Mietvertrag' });
    const copy = await archived('vertrag-kopie.txt', 'Mietvertrag Text (Kopie)', { title: 'Mietvertrag Kopie' });
    await archived('alt.txt', 'Alte Notiz ohne Bezug', { title: 'Alte Notiz', docType: 'Notiz' });
    const linked = await archived('verknuepft.txt', 'Mit Bezug', { title: 'Verknüpftes Dokument', docType: 'Notiz' });
    const other = await archived('anderes.txt', 'Anderes Dokument', { title: 'Anderes Dokument', docType: 'Notiz' });
    patch(copy, { sha256: app.services.documents.getRow(original).sha256, size: 3 * 1024 * 1024 });
    patch(original, { size: 3 * 1024 * 1024 });
    app.services.graph.linkEntries({ sourceId: linked, targetId: other, relationType: 'relates_to' }, { status: 'confirmed', trigger: 'manual' });

    const out = await call('storage_report', {});

    expect(out.summary).toBe('6.0 MB, 1 Duplikatgruppen');
    expect(out.content).toContain('Exakte Duplikate (gleicher Inhalt): 1 Gruppen, 3.0 MB verschwendet:');
    const group = out.content.split('\n').find((line) => line.startsWith('- 2× 3.0 MB:'))!;
    expect(group).toContain(ctx.refs.doc(original));
    expect(group).toContain(ctx.refs.doc(copy));
    expect(group).not.toContain('Alte Notiz');
    expect(out.content).toContain('Näherung: Archivist erfasst nicht, wann ein Dokument zuletzt geöffnet wurde');
    const unused = out.content.split('Vermutlich lange nicht genutzt')[1]!;
    expect(unused).toContain('„Alte Notiz“');
    expect(unused).not.toContain('Verknüpftes Dokument');
  });
});

describe('find_foreign_language_documents and search with translations (#312)', () => {
  const GERMAN = 'Sehr geehrte Damen und Herren, wir haben Ihre Rechnung nicht erhalten und bitten Sie, den Betrag bis zum Monatsende zu überweisen.';
  const ENGLISH =
    'Dear customer, please find the contract for your order attached. We will ship the goods once the signed copy has been received and this is not the end.';
  const FRENCH = 'Nous vous remercions pour votre commande. Les marchandises sont expédiées dans les trois jours et vous avez une facture pour les frais.';

  it('lists the documents in other languages with the detected language and counts the unclear ones', async () => {
    const de = await archived('brief.txt', GERMAN, { docType: 'Brief' });
    const en = await archived('letter.txt', ENGLISH, { docType: 'Brief' });
    const fr = await archived('lettre.txt', FRENCH, { docType: 'Brief' });
    await archived('kurz.txt', 'Rechnung 4711', { docType: 'Brief' });
    const secret = await archived('geheim.txt', `${ENGLISH} Secret.`, { docType: 'Brief', title: 'Geheimer Brief' });
    lockDocument(secret);
    for (const id of [de, en, fr]) patch(id, { llmStatus: 'analyzed' });

    const out = await call('find_foreign_language_documents', {});

    expect(out.summary).toBe('2 fremdsprachig');
    expect(out.content).toMatch(new RegExp(`Englisch \\(1, Ergebnismenge S\\d+\\):\\n- ${ctx.refs.doc(en)}:`));
    expect(out.content).toMatch(new RegExp(`Französisch \\(1, Ergebnismenge S\\d+\\):\\n- ${ctx.refs.doc(fr)}:`));
    expect(out.content).not.toContain(ctx.refs.doc(de));
    expect(out.content).toContain('1 ohne eindeutige Sprache');
    expect(out.content).toContain('1 nicht freigegeben');
    expect(out.content).not.toContain('Geheimer Brief');

    const asEnglishReader = await call('find_foreign_language_documents', { language: 'en', documents: [ctx.refs.doc(de), ctx.refs.doc(en)] });
    expect(asEnglishReader.content).toContain('Deutsch (1');
    expect(asEnglishReader.content).not.toContain('Englisch (');
  });

  it('says so when everything is in the own language', async () => {
    await archived('brief.txt', GERMAN, { docType: 'Brief' });
    expect((await call('find_foreign_language_documents', {})).summary).toBe('keine fremdsprachigen');
  });

  it('search adds hits of translated terms without repeating earlier hits', async () => {
    const en = await archived('letter.txt', ENGLISH, { docType: 'Brief', title: 'Contract letter' });
    const de = await archived('vertrag.txt', 'Der Vertrag wurde unterschrieben.', { docType: 'Vertrag', title: 'Vertrag Haus' });

    const only = await call('search', { query: 'Vertrag', types: ['document'] });
    expect(only.content).toContain(ctx.refs.doc(de));
    expect(only.content).not.toContain(ctx.refs.doc(en));

    const both = await call('search', { query: 'Vertrag', alsoTry: ['contract', 'Vertrag'], types: ['document'] });
    expect(both.content).toContain(ctx.refs.doc(en));
    expect(both.content.match(new RegExp(`${ctx.refs.doc(de)}:`, 'g'))).toHaveLength(1);
  });
});

describe('capture_device (#312)', () => {
  const receipt = 'Elektro Huber\nWaschmaschine Bosch WAN28\nSeriennummer: FD-8812-3456\n10 Jahre Garantie auf den Motor\nGesamt 599,00 €';

  it('stores serial number and warranty with the computation path, links the receipt and sets one reminder', async () => {
    const id = await archived('beleg-waschmaschine.txt', receipt, { date: '2026-09-01', title: 'Beleg Waschmaschine' });

    const out = await call('capture_device', { device: 'Waschmaschine Bosch', receipt: ctx.refs.doc(id) });

    expect(out.summary).toBe('Garantie bis 2036-09-01');
    expect(out.content).toContain('Seriennummer: FD-8812-3456');
    expect(out.content).toContain('Garantie bis: 01.09.2036');
    expect(out.content).toContain('Rechenweg: Kaufdatum 01.09.2026 + 10 Jahre = 01.09.2036 (Beleg: „10 Jahre Garantie“)');
    expect(out.content).toContain('Erinnerung am 2036-09-01 angelegt.');
    const note = app.services.graph.listEntities({ type: 'note' }).find((e) => e.name === 'Gerät: Waschmaschine Bosch')!;
    expect(note.description).toContain('Seriennummer: FD-8812-3456');
    expect(app.services.graph.relationsOf(note.id).some((r) => r.targetEntityId === id && r.status === 'confirmed')).toBe(true);
    expect(app.services.reminders.list('pending').map((r) => [r.targetType, r.targetId, r.remindAt, r.title])).toEqual([
      ['document', id, '2036-09-01', 'Garantie endet: Waschmaschine Bosch'],
    ]);

    const again = await call('capture_device', { device: 'Waschmaschine Bosch', receipt: ctx.refs.doc(id) });
    expect(again.content).toContain('war schon erfasst');
    expect(again.content).toContain('gab es schon – keine zweite angelegt');
    expect(app.services.reminders.list('pending')).toHaveLength(1);
    expect(app.services.graph.listEntities({ type: 'note' }).filter((e) => e.name.startsWith('Gerät:'))).toHaveLength(1);
  });

  it('takes a given serial number, period and warranty end over the receipt, and checks them', async () => {
    const id = await archived('beleg-fon.txt', 'Telefon\nGesamt 99,00 €', { date: '2026-09-01', title: 'Beleg Telefon' });
    const ref = ctx.refs.doc(id);

    const months = await call('capture_device', { device: 'Telefon', receipt: ref, serialNumber: 'sn 99887766', warrantyMonths: 120 });
    expect(months.content).toContain('Seriennummer: SN99887766');
    expect(months.content).toContain('Kaufdatum 01.09.2026 + 120 Monate = 01.09.2036');

    const end = await call('capture_device', { device: 'Telefon 2', receipt: ref, warrantyEnd: '2040-01-31' });
    expect(end.content).toContain('Garantie bis: 31.01.2040');
    expect(end.content).toContain('Garantieende vom Benutzer genannt: 31.01.2040');
    expect(end.content).toContain('keine Seriennummer erkannt');

    const badSerial = await call('capture_device', { device: 'Telefon', receipt: ref, serialNumber: '12' });
    expect(badSerial.isError).toBe(true);
    expect(badSerial.content).toContain('keine gültige Seriennummer');
    const badDate = await call('capture_device', { device: 'Telefon', receipt: ref, warrantyEnd: 'irgendwann' });
    expect(badDate.isError).toBe(true);
    expect((await call('capture_device', { device: 'Telefon', receipt: 'D99' })).isError).toBe(true);
  });

  it('assumes the legal warranty when the receipt names none, and sets no reminder for an expired one', async () => {
    const id = await archived('beleg-alt.txt', 'Toaster\nSeriennummer: TS-1234-ZZ\nGesamt 30,00 €', { date: '2020-01-10', title: 'Beleg Toaster' });

    const out = await call('capture_device', { device: 'Toaster', receipt: ctx.refs.doc(id) });

    expect(out.content).toContain('Kaufdatum 10.01.2020 + 24 Monate = 10.01.2022 (Annahme: gesetzliche Gewährleistung, der Beleg nennt keine Garantiezeit)');
    expect(out.content).toContain('Keine Erinnerung angelegt: Die Garantie ist schon abgelaufen.');
    expect(app.services.reminders.list('pending')).toEqual([]);
  });

  it('refuses a receipt that is not released for transmission', async () => {
    const id = await archived('beleg-geheim.txt', 'Gerät\nSeriennummer: GG-1234-XX', { date: '2026-09-01' });
    lockDocument(id);

    const out = await call('capture_device', { device: 'Gerät', receipt: ctx.refs.doc(id) });

    expect(out.isError).toBe(true);
    expect(app.services.graph.listEntities({ type: 'note' })).toEqual([]);
  });
});

describe('family members (#312)', () => {
  it('find_documents resolves a person through name and aliases instead of a substring', async () => {
    const lena = await archived('zeugnis.txt', 'Zeugnis', { persons: ['Lena Muster'], docType: 'Zeugnis' });
    const lenaB = await archived('arzt.txt', 'Arztbrief', { persons: ['Lena Muster'], docType: 'Brief' });
    const other = await archived('lenard.txt', 'Brief', { persons: ['Lenard Meier'], docType: 'Brief' });
    const person = app.services.graph.findByName('person', 'Lena Muster')!;
    app.services.graph.addAlias(person.id, 'meine Tochter');
    app.services.graph.addAlias(person.id, 'Lenchen');

    for (const mention of ['Lena Muster', 'meine Tochter', 'Lenchen', 'lena muster']) {
      const out = await call('find_documents', { person: mention });
      expect(out.content, mention).toContain(ctx.refs.doc(lena));
      expect(out.content, mention).toContain(ctx.refs.doc(lenaB));
      expect(out.content, mention).not.toContain(ctx.refs.doc(other));
    }
    // a mention no person is known for stays a plain substring match
    const partial = await call('find_documents', { person: 'Meier' });
    expect(partial.content).toContain(ctx.refs.doc(other));
    expect(partial.content).not.toContain(ctx.refs.doc(lena));
    expect((await call('find_documents', { person: 'Unbekannte Tante' })).content).toContain('Keine Dokumente gefunden');
  });

  it('resolve_person knows the alias, reports ambiguous mentions and unknown persons', async () => {
    await archived('zeugnis.txt', 'Zeugnis', { persons: ['Lena Muster'], docType: 'Zeugnis' });
    const person = app.services.graph.findByName('person', 'Lena Muster')!;
    app.services.graph.addAlias(person.id, 'meine Tochter');

    const known = await call('resolve_person', { name: 'meine Tochter' });
    expect(known.content).toMatch(/K\d+ Lena Muster \(erkannt über alias\)/);
    expect((await call('resolve_person', { name: 'meine Frau' })).content).toContain('Keine bekannte Person');
    expect((await call('resolve_person', { name: 'Muster' })).content).toContain('Nicht eindeutig');
  });
});
