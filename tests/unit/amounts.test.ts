import { describe, expect, it } from 'vitest';
import { findAmounts, formatEuro, invoiceTotal, labelledTotal, parseNumber } from '../../packages/core/src/agent/tools/research/amounts';

describe('numbers as written in documents', () => {
  it.each([
    ['42', 42],
    ['1234', 1234],
    ['12,50', 12.5],
    ['12.50', 12.5],
    ['1,234', 1234],
    ['1.234', 1234],
    ['1.234.567', 1234567],
    ['1,234,567', 1234567],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1 234,56', 1234.56],
    ["1'234.56", 1234.56],
    ['1 234,56', 1234.56],
    ['+12,50', 12.5],
    ['-12,50', -12.5],
    ['−12,50', -12.5],
  ])('reads „%s“ as %d', (raw, value) => {
    expect(parseNumber(raw)).toBe(value);
  });

  it.each(['', 'abc', ',5.00', '12,50-', '1,2345', '1.234.5678', '1'.repeat(400)])('rejects „%s“', (raw) => {
    expect(parseNumber(raw)).toBeNull();
  });
});

describe('money amounts in a text', () => {
  it('skips a currency amount whose number cannot be read', () => {
    expect(findAmounts("EUR 1.234'567")).toEqual([]);
  });
});

describe('invoice total', () => {
  it('prefers a total line over a larger amount elsewhere', () => {
    expect(invoiceTotal('Gesamt 100,00 €\nAnzahlung 500,00 €')).toEqual({ amount: 100, line: 'Gesamt 100,00 €' });
  });

  it('counts plain decimals only on total lines and only without currency amounts', () => {
    expect(invoiceTotal('Artikel 12,50\nKaffee 3,50 €')?.amount).toBe(3.5);
    expect(invoiceTotal('Gesamt 100,00 € (Anzahlung 500,00)')?.amount).toBe(100);
  });

  it.each([
    ['Total: 80,00', 80],
    ['Zu zahlen 80,00', 80],
    ['Zu  zahlen 80,00', 80],
    ['Amount due 80.00', 80],
    ['Amount  due 80.00', 80],
    ['Gesamt 1.234,56', 1234.56],
    ['Gesamt 112.50', 112.5],
    ['Gesamt 12,50 Euro', 12.5],
    ['Gesamt -12,50 und 3,00', 3],
    ['Gesamt 12.50 Euro', 12.5],
  ])('reads the plain total in „%s“', (text, amount) => {
    expect(invoiceTotal(text)?.amount).toBe(amount);
  });

  it('ignores lines without a positive amount', () => {
    expect(invoiceTotal('Gutschrift -50,00 €')).toBeNull();
    expect(invoiceTotal('Versand 0,00 €')).toBeNull();
    expect(invoiceTotal('Gesamt -12.50')).toBeNull();
  });

  it('takes the largest amount of a line and returns the trimmed line', () => {
    expect(invoiceTotal('  Kaffee 3,50 € Kuchen 4,20 €  ')).toEqual({ amount: 4.2, line: 'Kaffee 3,50 € Kuchen 4,20 €' });
  });

  it('falls back to the first largest amount', () => {
    expect(invoiceTotal('Kaffee 3,50 €\nTee 3,50 €')?.line).toBe('Kaffee 3,50 €');
    expect(invoiceTotal('Kuchen 4,20 €\nKaffee 3,50 €')?.amount).toBe(4.2);
  });

  it('does not let lines with tax, net or discount words win, unless they say gross or total', () => {
    expect(invoiceTotal('Zwischensumme 1.000,00 €\nSumme 900,00 €')?.amount).toBe(900);
    expect(invoiceTotal('Gesamtbetrag inkl. MwSt 1.190,00 €\nZwischensumme 1.000,00 €')?.amount).toBe(1190);
    expect(invoiceTotal('Summe 100,00 €\nBereits bezahlt: Betrag 500,00 €')?.amount).toBe(100);
    expect(invoiceTotal('Summe 100,00 €\nBereits  bezahlt: Betrag 500,00 €')?.amount).toBe(100);
    expect(invoiceTotal('Kaffee 500,00 €\nNetto 600,00 €')?.amount).toBe(600);
  });

  it('prefers the stronger total keyword and then the larger or later amount', () => {
    expect(invoiceTotal('Gesamt 100,00 €\nSumme 120,00 €')?.amount).toBe(100);
    expect(invoiceTotal('Summe 120,00 €\nGesamt 100,00 €')?.amount).toBe(100);
    expect(invoiceTotal('Gesamt 100,00 €\nGesamt 120,00 €')?.amount).toBe(120);
    expect(invoiceTotal('Gesamt 120,00 €\nGesamt 100,00 €')?.amount).toBe(120);
    expect(invoiceTotal('Gesamt 100,00 € A\nGesamt 100,00 € B')?.line).toBe('Gesamt 100,00 € B');
  });
});

describe('labelled total', () => {
  it('takes only a total line, never the largest amount of a document without one', () => {
    expect(labelledTotal('Kaution 2.550,00 €\nMiete 850,00 €')).toBeNull();
    expect(invoiceTotal('Kaution 2.550,00 €\nMiete 850,00 €')?.amount).toBe(2550);
  });

  it('skips subtotal and tax lines for the gross total', () => {
    expect(labelledTotal('Zwischensumme 100,00 €\nMwSt 19 % 19,00 €\nRechnungsbetrag 119,00 €')).toEqual({ amount: 119, line: 'Rechnungsbetrag 119,00 €' });
  });
});

describe('formatting euros', () => {
  it('groups thousands without an empty leading group and never writes „-0“', () => {
    expect(formatEuro(123)).toBe('123,00 €');
    expect(formatEuro(123456.7)).toBe('123.456,70 €');
    expect(formatEuro(0)).toBe('0,00 €');
    expect(formatEuro(-0.5)).toBe('-0,50 €');
  });
});
