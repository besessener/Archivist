import { describe, expect, it } from 'vitest';
import { classifyLocally } from '../../packages/core/src/services/classifier';

const now = new Date('2026-03-01T12:00:00Z');
const classify = (fileName: string, text: string) => classifyLocally({ fileName, ext: 'pdf', text, knownTopics: [], knownProjects: [], now });

describe('local classifier keywords (issue #69)', () => {
  it('does not treat "Preise" as travel', () => {
    const offer = classify('Angebot.pdf', 'Unsere Preise 2026 für die Wartung der Anlage.');
    expect(offer.categoryPath).not.toMatch(/vacation/);
    expect(offer.docType).not.toBe('Urlaub/Reise');

    const invoice = classify('Rechnung 4711.pdf', 'Rechnung über die Preise 2026, Rechnungsnummer 4711.');
    expect(invoice.categoryPath).toBe('private/finance/invoices/2026');
    expect(invoice.docType).toBe('Rechnung');
  });

  it('matches keywords as whole words or word starts', () => {
    expect(classify('Reise.pdf', 'Die Reise nach Rom.').categoryPath).toBe('private/vacation/2026');
    expect(classify('Abrechnung.pdf', 'Reisekosten März 2026').categoryPath).toBe('private/vacation/2026');
    expect(classify('Reise_Rom_2026.pdf', 'Programm').categoryPath).toBe('private/vacation/2026');
    expect(classify('Notiz.pdf', 'Hotel-Buchung bestätigt.').docType).toBe('Urlaub/Reise');
  });

  it('ignores keywords in the middle of a word, including after umlauts', () => {
    expect(classify('Notiz.pdf', 'Die Preisentwicklung und Kreisel.').categoryPath).toBe('private/unsortiert');
    // "ß" is a letter, so "flug" inside "Großflughafen" is no word start
    expect(classify('Notiz.pdf', 'Baustelle am Großflughafen').categoryPath).toBe('private/unsortiert');
    // "Umsatzsteuer" on an invoice does not make it a tax document
    expect(classify('Beleg.pdf', 'Rechnung inkl. Umsatzsteuer, zahlbar bis 2026-04-01.').docType).toBe('Rechnung');
  });

  it('still recognises the other rules', () => {
    expect(classify('Steuererklärung 2025.pdf', '').docType).toBe('Steuerdokument');
    expect(classify('Notiz.pdf', 'Protokoll Jour fixe').docType).toBe('Protokoll');
    expect(classify('ADR-012.md', 'ADR: Wir nutzen SQLite').docType).toBe('Architektur');
    expect(classify('Notiz.pdf', 'Die Adresse lautet …').categoryPath).toBe('private/unsortiert');
  });
});
