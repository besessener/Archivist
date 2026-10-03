import { describe, expect, it } from 'vitest';
import { deadlineTitlePrefix, reminderDay } from '../../packages/core/src/agent/tools/research/deadline-coverage';
import { DEADLINE_LABEL, findDeadlines, type DeadlineOptions } from '../../packages/core/src/agent/tools/research/deadlines';

const TODAY = new Date(2026, 9, 2);
const find = (text: string, options: Partial<DeadlineOptions> = {}) => findDeadlines(text, { baseDate: null, today: TODAY, ...options });
const only = (text: string, options: Partial<DeadlineOptions> = {}) => {
  const hits = find(text, options);
  expect(hits, text).toHaveLength(1);
  return hits[0]!;
};

describe('deadline labels', () => {
  it('names every kind of deadline in German', () => {
    expect(DEADLINE_LABEL).toEqual({
      kuendigung: 'Kündigungsfrist',
      garantie: 'Garantie/Gewährleistung',
      ausweis: 'Ausweis/Dokument läuft ab',
      versicherung: 'Versicherung',
      tuev: 'TÜV/Hauptuntersuchung',
      widerspruch: 'Widerspruchs-/Widerrufsfrist',
      ablauf: 'Ablauf/Vertragsende',
      faelligkeit: 'Fälligkeit',
    });
  });
});

describe('dates after a keyword', () => {
  it.each([
    ['Kündbar zum 31.12.2026', 'kuendigung'],
    ['Garantie bis 31.12.2026', 'garantie'],
    ['Widerspruch bis 31.12.2026', 'widerspruch'],
    ['Zahlbar bis 31.12.2026', 'faelligkeit'],
    ['Zahlbar  bis 31.12.2026', 'faelligkeit'],
    ['Zu zahlen bis 31.12.2026', 'faelligkeit'],
    ['Zu  zahlen  bis 31.12.2026', 'faelligkeit'],
    ['Gültig bis 31.12.2026', 'ablauf'],
    ['Gültig  bis 31.12.2026', 'ablauf'],
    ['gueltig bis 31.12.2026', 'ablauf'],
    ['gueltig  bis 31.12.2026', 'ablauf'],
    ['Valid until 31.12.2026', 'ablauf'],
    ['Valid  until 31.12.2026', 'ablauf'],
    ['Cards expire 31.12.2026', 'ablauf'],
    ['Läuft ab am 31.12.2026', 'ablauf'],
    ['Läuft  ab am 31.12.2026', 'ablauf'],
    ['laeuft ab am 31.12.2026', 'ablauf'],
    ['laeuft  ab am 31.12.2026', 'ablauf'],
    ['Endet am 31.12.2026', 'ablauf'],
    ['Endet  am 31.12.2026', 'ablauf'],
    ['Endet zum 31.12.2026', 'ablauf'],
    ['Endet  zum 31.12.2026', 'ablauf'],
    ['Laufzeit bis 31.12.2026', 'ablauf'],
    ['Laufzeit  bis 31.12.2026', 'ablauf'],
    ['Befristet bis 31.12.2026', 'ablauf'],
    ['Befristet  bis 31.12.2026', 'ablauf'],
  ])('reads „%s“ as %s', (text, kind) => {
    expect(only(text)).toMatchObject({ kind, date: '2026-12-31' });
  });

  it('quotes the line of the date, whitespace collapsed, and says where the date comes from', () => {
    const text = 'Erste Zeile\n  Kündbar   zum 31.12.2026  \nLetzte Zeile';

    expect(only(text)).toEqual({
      kind: 'kuendigung',
      date: '2026-12-31',
      evidence: 'Kündbar zum 31.12.2026',
      rechenweg: 'Datum steht im Text: 31.12.2026',
      past: false,
    });
    expect(only('Rechnung\nGültig bis 14.02.2031').evidence).toBe('Gültig bis 14.02.2031');
    expect(only('Nächste HU 08/2027').rechenweg).toBe('Datum steht im Text (Monat/Jahr → Monatsende): 31.08.2027');
  });

  it('only counts a keyword on the same line and at most 70 characters before the date', () => {
    expect(find('Garantie: siehe unten\nAm 12.05.2026 war schönes Wetter.')).toEqual([]);
    expect(find(`Garantie ${'x'.repeat(70)} 12.05.2026`)).toEqual([]);
  });

  it('takes the keyword closest to the date', () => {
    expect(only('Gültig bis zur Kündigung am 31.12.2027').kind).toBe('kuendigung');
  });
});

describe('notice periods', () => {
  it('names the end the period counts back from', () => {
    expect(find('Frist 3 Monate vor Ablauf 31.12.2026').find((hit) => hit.kind === 'kuendigung')?.rechenweg).toBe(
      'Ablauf 31.12.2026 − 3 Monate = 30.09.2026 (Kündigung muss spätestens dann zugehen)',
    );
    expect(only('Frist 1 Monat zum 31.12.2026')).toMatchObject({
      kind: 'kuendigung',
      date: '2026-11-30',
      rechenweg: 'Stichtag 31.12.2026 − 1 Monat = 30.11.2026 (Kündigung muss spätestens dann zugehen)',
    });
  });

  it('reads number words in any case', () => {
    expect(only('Frist Drei Monate zum 31.12.2026').date).toBe('2026-09-30');
    expect(only('Frist zwölf Monate zum 31.12.2026').date).toBe('2025-12-31');
  });

  it('keeps a period without a known end, saying the date is missing', () => {
    expect(only('Kündigungsfrist 3 Monate zum Vertragsende.')).toMatchObject({
      kind: 'kuendigung',
      date: null,
      rechenweg: '3 Monate vor dem Vertragsende – das Datum dafür steht nicht im Text',
      past: false,
    });
  });

  it('uses the first contract end of the text, even when other dates come first', () => {
    const notice = (text: string) => find(text).find((hit) => hit.kind === 'kuendigung')?.date;

    expect(notice('Fällig am 01.03.2026\nVertragsende 31.12.2026\nKündigungsfrist 3 Monate zum Vertragsende')).toBe('2026-09-30');
    expect(notice('Vertragsende 31.12.2026\nLaufzeit bis 31.12.2027\nKündigungsfrist 3 Monate zum Vertragsende')).toBe('2026-09-30');
  });

  it('ignores a period of zero', () => {
    expect(find('Frist 0 Monate zum 31.12.2026')).toEqual([]);
    expect(find('Garantie 0 Monate', { baseDate: '2026-03-15' })).toEqual([]);
  });
});

describe('periods counted from the document date', () => {
  const base = { baseDate: '2026-03-15' };

  it.each([
    ['Widerspruch ist innerhalb von 14 Tagen möglich', 'widerspruch', '2026-03-29', 'Dokumentdatum 15.03.2026 + 14 Tage = 29.03.2026'],
    ['Widerruf innerhalb 1 Tag', 'widerspruch', '2026-03-16', 'Dokumentdatum 15.03.2026 + 1 Tag = 16.03.2026'],
    ['Einspruch innerhalb von 1 Woche', 'widerspruch', '2026-03-22', 'Dokumentdatum 15.03.2026 + 1 Woche = 22.03.2026'],
    ['Innerhalb von 2 Wochen Widerspruch einlegen', 'widerspruch', '2026-03-29', 'Dokumentdatum 15.03.2026 + 2 Wochen = 29.03.2026'],
    ['2 Jahre Garantie', 'garantie', '2028-03-15', 'Dokumentdatum 15.03.2026 + 2 Jahre = 15.03.2028'],
    ['Gewährleistung: 1 Jahr', 'garantie', '2027-03-15', 'Dokumentdatum 15.03.2026 + 1 Jahr = 15.03.2027'],
    ['Herstellergarantie von 1 Monat', 'garantie', '2026-04-15', 'Dokumentdatum 15.03.2026 + 1 Monat = 15.04.2026'],
    ['Zahlbar innerhalb von 14 Tagen', 'faelligkeit', '2026-03-29', 'Dokumentdatum 15.03.2026 + 14 Tage = 29.03.2026'],
  ])('reads „%s“', (text, kind, date, rechenweg) => {
    expect(only(text, base)).toMatchObject({ kind, date, rechenweg });
  });

  it('keeps a period without a base date and names the base', () => {
    expect(only('Garantie 24 Monate')).toMatchObject({
      kind: 'garantie',
      date: null,
      rechenweg: '24 Monate ab Dokumentdatum – das Dokumentdatum ist unbekannt',
    });
    expect(only('Garantie 24 Monate', { baseLabel: 'Archivdatum' }).rechenweg).toBe('24 Monate ab Archivdatum – das Archivdatum ist unbekannt');
  });
});

describe('the list of deadlines', () => {
  it('marks only dates before today as past', () => {
    expect(only('Fällig am 15.09.2026').past).toBe(true);
    expect(only('Fällig am 02.10.2026').past).toBe(false);
  });

  it('lists the same deadline once but keeps other kinds or dates', () => {
    expect(find('Garantie bis 15.03.2028\nGarantie 24 Monate', { baseDate: '2026-03-15' })).toHaveLength(1);
    expect(find('Fällig am 31.12.2026\nVertragsende 31.12.2026').map((hit) => hit.kind)).toEqual(['faelligkeit', 'ablauf']);
    expect(find('Garantie bis 01.01.2027\nGarantie bis 01.01.2028').map((hit) => hit.date)).toEqual(['2027-01-01', '2028-01-01']);
  });

  it('sorts by date and puts deadlines without a date last', () => {
    const hits = find('Garantie 24 Monate\nFällig am 31.12.2027\nWiderspruch bis 01.06.2027');

    expect(hits.map((hit) => [hit.kind, hit.date])).toEqual([
      ['widerspruch', '2027-06-01'],
      ['faelligkeit', '2027-12-31'],
      ['garantie', null],
    ]);
    const undated = find('Kündigungsfrist 3 Monate zum Vertragsende.\nGarantie 24 Monate', { baseDate: '2026-03-15' });
    expect(undated.map((hit) => [hit.kind, hit.date])).toEqual([
      ['garantie', '2028-03-15'],
      ['kuendigung', null],
    ]);
  });
});

describe('deadline reminders', () => {
  const notice = { kind: 'kuendigung', date: '2026-12-31' } as const;

  it('puts the reminder the lead time before the deadline, but not before today', () => {
    expect(reminderDay({ deadline: notice, leadDays: 14, today: '2026-10-02' })).toBe('2026-12-17');
    expect(reminderDay({ deadline: notice, leadDays: 365, today: '2026-10-02' })).toBe('2026-10-02');
    expect(reminderDay({ deadline: notice, leadDays: 1, today: '2026-12-31' })).toBe('2026-12-31');
  });

  it('keys a deadline by its kind and German date', () => {
    expect(deadlineTitlePrefix(notice)).toBe('Kündigungsfrist 31.12.2026');
  });
});
