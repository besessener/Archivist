import { describe, expect, it } from 'vitest';
import { findAmounts, formatEuro, invoiceTotal, parseAmount, sumAmounts } from '../../packages/core/src/agent/tools/research/amounts';
import { addPeriod } from '../../packages/core/src/agent/tools/research/dates';
import { findDeadlines } from '../../packages/core/src/agent/tools/research/deadlines';
import { diffLines } from '../../packages/core/src/agent/tools/research/diff';
import { monthGaps, numberGaps, sequenceNumber } from '../../packages/core/src/agent/tools/research/gaps';
import { normalizeSubject } from '../../packages/core/src/agent/tools/research/mail';
import { invoiceNumber, matchPayments, parseStatement } from '../../packages/core/src/agent/tools/research/payments';
import { problemReasons } from '../../packages/core/src/agent/tools/research/problems';
import { scanSecrets } from '../../packages/core/src/agent/tools/research/secrets';
import { looksLikeVersions, versionKey } from '../../packages/core/src/agent/tools/duplicates';

const TODAY = new Date(2026, 9, 2);

describe('research helpers of the agent', () => {
  describe('money amounts', () => {
    it('parses German, English and prefixed amounts', () => {
      expect(parseAmount('1.234,56 €')).toBe(1234.56);
      expect(parseAmount('EUR 99,00')).toBe(99);
      expect(parseAmount('€ 12.50')).toBe(12.5);
      expect(parseAmount('Total: 1,234.56 EUR')).toBe(1234.56);
      expect(parseAmount('Preis 1.500 €')).toBe(1500);
      expect(parseAmount('keine Zahl')).toBeNull();
      expect(findAmounts('Netto 100,00 € zzgl. 19,00 € MwSt').map((a) => a.value)).toEqual([100, 19]);
    });

    it('prefers the total line over the largest amount and falls back to the largest amount', () => {
      const text = ['Position A 500,00 €', 'Position B 734,56 €', 'Zwischensumme 1.234,56 €', 'MwSt 19% 234,57 €', 'Gesamtbetrag 1.469,13 €'].join('\n');
      expect(invoiceTotal(text)).toEqual({ amount: 1469.13, line: 'Gesamtbetrag 1.469,13 €' });
      expect(invoiceTotal('Kaffee 3,50 €\nKuchen 4,20 €')?.amount).toBe(4.2);
      expect(invoiceTotal('Rechnungsbetrag: 80,00')?.amount).toBe(80);
      expect(invoiceTotal('Kein Betrag hier')).toBeNull();
    });

    it('sums exactly and formats in German', () => {
      expect(sumAmounts([0.1, 0.2, 1234.56])).toBe(1234.86);
      expect(formatEuro(1234.56)).toBe('1.234,56 €');
      expect(formatEuro(1234567.5)).toBe('1.234.567,50 €');
      expect(formatEuro(-89)).toBe('-89,00 €');
    });
  });

  describe('gaps', () => {
    it('lists missing months of a series', () => {
      const g = monthGaps(['2026-01-31', '2026-02-28', '2026-04-30', '2026-05-31', '2026-07-31']);
      expect(g.first).toBe('2026-01');
      expect(g.last).toBe('2026-07');
      expect(g.missing).toEqual(['2026-03', '2026-06']);
    });

    it('spans year boundaries', () => {
      expect(monthGaps(['2025-11-01', '2026-02-01']).missing).toEqual(['2025-12', '2026-01']);
    });

    it('detects sequence numbers and missing numbers', () => {
      expect(sequenceNumber('Kontoauszug Nr. 12')).toEqual({ kind: 'number', n: 12 });
      expect(sequenceNumber('Auszug 3')).toEqual({ kind: 'number', n: 3 });
      expect(sequenceNumber('Gehalt 2025-07')).toEqual({ kind: 'month', month: '2025-07' });
      expect(numberGaps([1, 2, 4, 7])).toEqual([3, 5, 6]);
      expect(numberGaps([5])).toEqual([]);
    });
  });

  describe('diff', () => {
    it('lists lines only in A and only in B', () => {
      const a = 'Vertrag\nLaufzeit 12 Monate\nPreis 10 €\nGerichtsstand Berlin';
      const b = 'Vertrag\nLaufzeit 24 Monate\nPreis 10 €\nGerichtsstand Berlin\nNeue Klausel';
      const r = diffLines(a, b);
      expect(r.onlyA).toEqual(['Laufzeit 12 Monate']);
      expect(r.onlyB).toEqual(['Laufzeit 24 Monate', 'Neue Klausel']);
      expect(r.common).toBe(3);
    });

    it('ignores whitespace and case differences', () => {
      expect(diffLines('Hallo   Welt', 'hallo welt')).toMatchObject({ onlyA: [], onlyB: [], common: 1 });
    });
  });

  describe('deadlines', () => {
    it('computes a notice period back from the contract end, with the computation path', () => {
      const hits = findDeadlines('Kündigungsfrist 3 Monate zum Vertragsende 31.12.2026.', { baseDate: '2025-01-01', today: TODAY });
      const k = hits.find((h) => h.kind === 'kuendigung');
      expect(k?.date).toBe('2026-09-30');
      expect(k?.rechenweg).toContain('31.12.2026 − 3 Monate = 30.09.2026');
      expect(k?.evidence).toContain('Kündigungsfrist 3 Monate');
      expect(hits.some((h) => h.kind === 'ablauf' && h.date === '2026-12-31')).toBe(true);
    });

    it('uses a contract end named elsewhere in the text', () => {
      const text = 'Vertragsende: 30.06.2027\nEs gilt eine Kündigungsfrist von 6 Wochen zum Vertragsende.';
      expect(findDeadlines(text, { baseDate: null, today: TODAY }).find((h) => h.kind === 'kuendigung')?.date).toBe('2027-05-19');
    });

    it('counts warranty and objection periods from the document date', () => {
      const text = 'Garantie 24 Monate ab Kaufdatum.\nSie können innerhalb von 4 Wochen Widerspruch einlegen.';
      const hits = findDeadlines(text, { baseDate: '2026-03-15', today: TODAY });
      expect(hits.find((h) => h.kind === 'garantie')).toMatchObject({ date: '2028-03-15', rechenweg: 'Dokumentdatum 15.03.2026 + 24 Monate = 15.03.2028' });
      expect(hits.find((h) => h.kind === 'widerspruch')?.date).toBe('2026-04-12');
    });

    it('recognizes TÜV month/year, ID expiry and due dates; marks past ones', () => {
      const hits = findDeadlines('Personalausweis\nGültig bis 14.02.2031', { baseDate: null, today: TODAY });
      expect(hits[0]).toMatchObject({ kind: 'ausweis', date: '2031-02-14', past: false });
      expect(findDeadlines('Nächste HU 08/2027', { baseDate: null, today: TODAY })[0]).toMatchObject({ kind: 'tuev', date: '2027-08-31' });
      expect(findDeadlines('Der Betrag ist fällig am 01.03.2026.', { baseDate: null, today: TODAY })[0]).toMatchObject({
        kind: 'faelligkeit',
        date: '2026-03-01',
        past: true,
      });
      expect(findDeadlines('Kfz-Versicherung, Ablauf 31.12.2026', { baseDate: null, today: TODAY })[0]?.kind).toBe('versicherung');
      expect(findDeadlines('Am 12.05.2026 war schönes Wetter.', { baseDate: null, today: TODAY })).toEqual([]);
    });

    it('adds and subtracts periods with month clamping', () => {
      expect(addPeriod('2026-01-31', { count: 1, unit: 'monat' })).toBe('2026-02-28');
      expect(addPeriod('2026-06-30', { count: -3, unit: 'monat' })).toBe('2026-03-31');
      expect(addPeriod('2026-03-01', { count: 2, unit: 'woche' })).toBe('2026-03-15');
      expect(addPeriod('2024-02-29', { count: 1, unit: 'jahr' })).toBe('2025-02-28');
    });
  });

  describe('secrets', () => {
    it('counts kinds without values', () => {
      const counts = scanSecrets('Login: max.muster\nPasswort: Geheim123!\nPIN: 1234\nIBAN DE89 3704 0044 0532 0130 00\nKey sk-abcdefghijklmnopqrstuv');
      expect(counts).toMatchObject({ 'Passwort/Schlüssel': 1, 'Benutzername/Zugangsdaten': 1, 'PIN/PUK/TAN': 1, IBAN: 1, 'API-Schlüssel': 1 });
      expect(JSON.stringify(counts)).not.toContain('Geheim123');
      expect(scanSecrets('IBAN DE00 1234 5678 9012 3456 78')).toEqual({});
    });
  });

  describe('mail and payments', () => {
    it('normalizes mail subjects', () => {
      expect(normalizeSubject('AW: WG: Re: Angebot Küche')).toBe('angebot küche');
      expect(normalizeSubject('Fwd: angebot  KÜCHE')).toBe('angebot küche');
    });

    it('parses statements and matches invoices by number or amount', () => {
      const payments = parseStatement(
        [
          'Kontoauszug 7/2026',
          '03.07.2026 Stadtwerke Abschlag -89,00',
          '10.07.2026 Gutschrift Gehalt 2.500,00',
          '20.07. Elektro Huber RE-2026-0042 1.190,00 S',
          '25.07.2026 Möbel Haus -450,00 EUR',
        ].join('\n'),
        2026,
      );
      expect(payments.map((p) => [p.date, p.amount])).toEqual([
        ['2026-07-03', -89],
        ['2026-07-10', 2500],
        ['2026-07-20', -1190],
        ['2026-07-25', -450],
      ]);
      expect(invoiceNumber('Rechnungsnummer: RE-2026-0042')).toBe('RE-2026-0042');
      const r = matchPayments(
        [
          { id: 'i1', date: '2026-07-01', amount: 1000, number: 'RE-2026-0042' },
          { id: 'i2', date: '2026-07-01', amount: 450, number: null },
          { id: 'i3', date: '2026-01-01', amount: 89, number: null },
        ],
        payments,
      );
      expect(r.matched.map((m) => [m.invoice.id, m.payment.date, m.by])).toEqual([
        ['i1', '2026-07-20', 'number'],
        ['i2', '2026-07-25', 'amount'],
      ]);
      expect(r.unpaid.map((i) => i.id)).toEqual(['i3']);
      expect(r.unmatched).toHaveLength(2);
    });
  });

  describe('problem files and versions', () => {
    it('explains problems in plain language', () => {
      expect(
        problemReasons({
          status: 'failed',
          processingError: 'PDF ist passwortgeschützt',
          ext: 'pdf',
          mime: 'application/pdf',
          textLength: 0,
          processingStatus: 'failed',
        })[0],
      ).toContain('verschlüsselt');
      expect(
        problemReasons({ status: 'archived', processingError: null, ext: 'pdf', mime: 'application/pdf', textLength: 0, processingStatus: 'extracted' })[0],
      ).toContain('Kein Text');
      expect(
        problemReasons({ status: 'archived', processingError: null, ext: 'txt', mime: 'text/plain', textLength: 10, processingStatus: 'extracted' }),
      ).toEqual([]);
    });

    it('strips version markers but keeps dated issues of a series apart', () => {
      expect(versionKey('Angebot Küche final.docx').key).toBe('angebot kuche');
      expect(versionKey('Angebot_Küche_v2 (1).docx')).toMatchObject({ key: 'angebot kuche', marker: true });
      expect(
        looksLikeVersions({ name: 'Angebot Küche final.docx', title: 'Angebot Küche final' }, { name: 'Angebot_Küche_v2.docx', title: 'Angebot Küche v2' }),
      ).toBe(true);
      expect(
        looksLikeVersions(
          { name: 'Protokoll 2026-01-10.txt', title: 'Protokoll 2026-01-10' },
          { name: 'Protokoll 2026-02-10.txt', title: 'Protokoll 2026-02-10' },
        ),
      ).toBe(false);
      expect(looksLikeVersions({ name: 'Bericht entwurf 2026-01-10.txt', title: 'Bericht' }, { name: 'Bericht 2026-02-10.txt', title: 'Bericht' })).toBe(true);
    });
  });
});
