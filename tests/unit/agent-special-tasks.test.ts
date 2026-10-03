import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '@archivist/shared';
import { extractSerialNumber, validateSerialNumber, warrantyFrom, warrantyPeriodIn } from '../../packages/core/src/agent/tools/research/devices';
import { detectLanguage, STOPWORDS } from '../../packages/core/src/agent/tools/research/languages';
import { mailHeadersOf, mailThreads, type MailEntry } from '../../packages/core/src/agent/tools/research/mail';
import { parseStatement } from '../../packages/core/src/agent/tools/research/payments';
import { matchReceipt, receiptFacts } from '../../packages/core/src/agent/tools/research/receipt-photos';

describe('statement formats', () => {
  it('reads CSV lines with ; or tab, comma or point decimals, quotes and a currency column', () => {
    const payments = parseStatement(
      [
        'Datum;Text;Betrag',
        '15.07.2026;Stadtwerke Abschlag;-89,00',
        '16.07.2026;"Elektro Huber RE-2026-0042";"-1.190,00 EUR"',
        '2026-07-17;Bäckerei;-12.40;EUR',
        '18.07.26\tGehalt\t+2.500,00',
        '19.07.2026;nur zwei Felder',
        '31.02.2026;Unmöglicher Tag;-5,00',
      ].join('\n'),
      2026,
    );
    expect(payments.map((p) => [p.date, p.amount, p.text])).toEqual([
      ['2026-07-15', -89, 'Stadtwerke Abschlag'],
      ['2026-07-16', -1190, 'Elektro Huber RE-2026-0042'],
      ['2026-07-17', -12.4, 'Bäckerei'],
      ['2026-07-18', 2500, 'Gehalt'],
    ]);
  });

  it('reads ISO dated free text lines and ignores lines in no known form', () => {
    expect(parseStatement('2026-07-15 Miete Juli -800,00\nirgendein Text\n2026-13-01 kaputt -1,00', 2026).map((p) => [p.date, p.amount])).toEqual([
      ['2026-07-15', -800],
    ]);
    expect(parseStatement('Das ist kein Kontoauszug.', 2026)).toEqual([]);
  });
});

describe('language detection', () => {
  const samples: Record<string, string> = {
    de: 'Sehr geehrte Damen und Herren, wir haben Ihre Rechnung nicht erhalten und bitten Sie, den Betrag bis zum Monatsende zu überweisen.',
    en: 'Dear customer, please find the invoice for your order attached. We will ship the goods once the payment has been received and this is not the end.',
    fr: 'Nous vous remercions pour votre commande. Les marchandises sont expédiées dans les trois jours et vous avez une facture pour les frais.',
    es: 'Gracias por su pedido. Los productos del almacén serán enviados para usted como siempre, pero este mes también hemos tenido muy pocos.',
    it: 'Gentile cliente, grazie per il suo ordine. Le merci sono state spedite nella giornata di oggi e non abbiamo ancora ricevuto il pagamento per questo.',
  };

  it.each(Object.entries(samples))('recognises %s', (language, text) => {
    expect(detectLanguage(text)?.language).toBe(language);
  });

  it('gives no answer for short, numeric or mixed text', () => {
    expect(detectLanguage('Rechnung 4711')).toBeNull();
    expect(detectLanguage('12345 67890 11,50 € 2026-07-01')).toBeNull();
    expect(detectLanguage(`${samples.de} ${samples.en}`)).toBeNull();
  });

  it('only looks at the beginning of a long text', () => {
    expect(detectLanguage(`${'x '.repeat(3000)}${samples.en}`)).toBeNull();
    expect(detectLanguage(`${samples.en} ${'x '.repeat(3000)}`)?.language).toBe('en');
  });

  it('keeps the stopword lists free of words that count for two languages', () => {
    const all = Object.values(STOPWORDS).flat();
    expect(all.length).toBe(new Set(all).size);
  });
});

describe('devices and warranties', () => {
  it('extracts and validates serial numbers', () => {
    expect(extractSerialNumber('Waschmaschine\nSeriennummer: wm-4711-ab\nPreis 499,00 €')).toEqual({ serial: 'WM-4711-AB', line: 'Seriennummer: wm-4711-ab' });
    expect(extractSerialNumber('S/N 123456789')?.serial).toBe('123456789');
    expect(extractSerialNumber('Serial No: C02XK1ABCD')?.serial).toBe('C02XK1ABCD');
    expect(extractSerialNumber('SN: 9988-7766')?.serial).toBe('9988-7766');
    // a word after the label is no serial number: the next label wins
    expect(extractSerialNumber('Seriennummer: Modellreihe\nS/N 55667788')?.serial).toBe('55667788');
    expect(extractSerialNumber('Seriennummer: Modellreihe')).toBeNull();
    expect(extractSerialNumber('snowboard123456 serialized77777')).toBeNull();
    expect(validateSerialNumber('ab 12 cd 34')).toBe('AB12CD34');
    expect(validateSerialNumber('1234')).toBeNull();
    expect(validateSerialNumber('ABCDEFG')).toBeNull();
    expect(validateSerialNumber('111111')).toBeNull();
    expect(validateSerialNumber('AB#12345')).toBeNull();
  });

  it('reads the warranty period of a receipt in words and numbers', () => {
    expect(warrantyPeriodIn('inklusive 24 Monate Garantie')?.period).toEqual({ count: 24, unit: 'monat' });
    expect(warrantyPeriodIn('Herstellergarantie: 3 Jahre ab Kauf')?.period).toEqual({ count: 3, unit: 'jahr' });
    expect(warrantyPeriodIn('zwei Jahre Gewährleistung')?.period).toEqual({ count: 2, unit: 'jahr' });
    expect(warrantyPeriodIn('Garantie von einem Jahr')?.period).toEqual({ count: 1, unit: 'jahr' });
    expect(warrantyPeriodIn('keine Angabe')).toBeNull();
  });

  it('computes the warranty end with the computation path, clamping month ends', () => {
    expect(warrantyFrom('2026-03-15', { count: 2, unit: 'jahr' })).toEqual({ end: '2028-03-15', rechenweg: 'Kaufdatum 15.03.2026 + 2 Jahre = 15.03.2028' });
    expect(warrantyFrom('2026-08-31', { count: 6, unit: 'monat' })).toEqual({ end: '2027-02-28', rechenweg: 'Kaufdatum 31.08.2026 + 6 Monate = 28.02.2027' });
    expect(warrantyFrom('2026-01-31', { count: 1, unit: 'monat' }).rechenweg).toBe('Kaufdatum 31.01.2026 + 1 Monat = 28.02.2026');
    expect(warrantyFrom('2026-01-31', { count: 1, unit: 'jahr' }).rechenweg).toContain('+ 1 Jahr =');
  });
});

describe('receipt photos', () => {
  const ocr = ['Media Markt', 'Hauptstr. 5', 'Datum 14.03.2026', 'Kopfhörer 49,90', 'Summe 49,90 EUR'].join('\n');

  it('reads shop, date and total of a receipt text', () => {
    expect(receiptFacts(ocr)).toEqual({ amount: 49.9, amountLine: 'Summe 49,90 EUR', date: '2026-03-14', merchant: 'Media Markt' });
    expect(receiptFacts('12.03.2026\n5,00')).toEqual({ amount: null, amountLine: null, date: '2026-03-12', merchant: null });
  });

  it('scores amount, date distance and shop name', () => {
    const facts = receiptFacts(ocr);
    const candidate = { amount: 49.9, date: '2026-03-15', names: ['Rechnung Media Markt'], text: '' };
    expect(matchReceipt(facts, candidate)).toEqual({ score: 100, reasons: ['gleicher Betrag', 'Datum 1 Tag(e) Abstand', 'Händler passt'] });
    expect(matchReceipt(facts, { ...candidate, amount: 10, date: '2026-03-14', names: ['Anderes'], text: 'kaufte bei media markt' })).toEqual({
      score: 50,
      reasons: ['gleiches Datum', 'Händler passt'],
    });
    expect(matchReceipt(facts, { ...candidate, names: [], date: '2026-03-25' }).score).toBe(65);
    expect(matchReceipt(facts, { amount: null, date: '2025-01-01', names: ['Zufall'], text: '' }).score).toBe(0);
    expect(matchReceipt(receiptFacts('nur Text'), { ...candidate, date: '2026-03-14' }).score).toBe(0);
  });
});

describe('mail threads', () => {
  const mail = (id: string, subject: string, date: string): DocumentRecord =>
    ({ id, title: subject, textPreview: `Betreff: ${subject} Von: a@x.test`, documentDate: date, createdAt: date }) as DocumentRecord;
  const entry = (id: string, subject: string, date: string, headers: Partial<MailEntry['headers']> = {}): MailEntry => ({
    doc: mail(id, subject, date),
    headers: { messageId: null, inReplyTo: null, references: [], ...headers },
  });

  it('keeps equal subjects of different threads apart when headers are present', () => {
    const threads = mailThreads([
      entry('a1', 'Angebot', '2026-03-01', { messageId: '<a1@x>' }),
      entry('a2', 'AW: Angebot', '2026-03-02', { messageId: '<a2@x>', inReplyTo: '<a1@x>', references: ['<a1@x>'] }),
      entry('a3', 'AW: AW: Angebot', '2026-03-03', { messageId: '<a3@x>', inReplyTo: '<a2@x>' }),
      entry('b1', 'Angebot', '2026-04-01', { messageId: '<b1@x>' }),
      entry('b2', 'Re: Angebot', '2026-04-02', { messageId: '<b2@x>', inReplyTo: '<b1@x>' }),
      entry('c1', 'Angebot', '2026-05-01', { messageId: '<c1@x>' }),
    ]);
    expect(threads.map((t) => [t.basis, t.mails.map((m) => m.id)])).toEqual([
      ['headers', ['a1', 'a2', 'a3']],
      ['headers', ['b1', 'b2']],
    ]);
  });

  it('joins replies whose original is not in the archive by their common reference', () => {
    const threads = mailThreads([
      entry('r1', 'Re: Frage', '2026-03-02', { messageId: '<r1@x>', inReplyTo: '<root@x>', references: ['<root@x>'] }),
      entry('r2', 'Re: Re: Frage', '2026-03-03', { messageId: '<r2@x>', inReplyTo: '<r1@x>', references: ['<root@x>', '<r1@x>'] }),
    ]);
    expect(threads).toEqual([{ basis: 'headers', label: 'frage', mails: [expect.objectContaining({ id: 'r1' }), expect.objectContaining({ id: 'r2' })] }]);
  });

  it('falls back to the normalized subject for mails without headers, and says so', () => {
    const threads = mailThreads([
      entry('s2', 'AW: Urlaub', '2026-03-02'),
      entry('s1', 'Urlaub', '2026-03-01'),
      entry('s3', 'Sonstiges', '2026-03-03'),
      entry('s4', '', '2026-03-04'),
      entry('s5', '', '2026-03-05'),
    ]);
    expect(threads.map((t) => [t.basis, t.label, t.mails.map((m) => m.id)])).toEqual([['subject', 'urlaub', ['s2', 's1']]]);
  });

  it('reads the headers from the stored metadata, tolerating anything else', () => {
    expect(mailHeadersOf({ messageId: '<a@x>', inReplyTo: ' <b@x> ', references: '<c@x> <d@x>' })).toEqual({
      messageId: '<a@x>',
      inReplyTo: '<b@x>',
      references: ['<c@x>', '<d@x>'],
    });
    expect(mailHeadersOf(null)).toEqual({ messageId: null, inReplyTo: null, references: [] });
    expect(mailHeadersOf({ messageId: 5, references: '' })).toEqual({ messageId: null, inReplyTo: null, references: [] });
  });
});
