import { describe, expect, it } from 'vitest';
import { fillPattern } from '../../packages/core/src/services/rename-pattern';

type PatternDocument = Parameters<typeof fillPattern>[1];

const document = (overrides: Partial<PatternDocument> = {}): PatternDocument => ({
  documentDate: '2026-03-15T10:00:00.000Z',
  archivedAt: '2026-04-01T08:00:00.000Z',
  createdAt: '2026-05-02T09:00:00.000Z',
  docType: 'Rechnung',
  persons: ['Stadtwerke', 'Anna'],
  title: 'Strom März',
  topicName: 'Energie',
  projectName: 'Haus',
  originalName: 'scan_001.final.pdf',
  ...overrides,
});

describe('naming scheme (#304)', () => {
  it('fills every placeholder', () => {
    const filled = fillPattern('{datum}|{date}|{jahr}|{monat}|{typ}|{absender}|{titel}|{thema}|{projekt}|{original}', document());

    expect(filled).toBe('2026-03-15|2026-03-15|2026|2026-03|Rechnung|Stadtwerke|Strom März|Energie|Haus|scan_001.final');
  });

  it('takes the archive date and then the creation date when the document date is missing', () => {
    expect(fillPattern('{datum}', document({ documentDate: null }))).toBe('2026-04-01');
    expect(fillPattern('{datum}', document({ documentDate: null, archivedAt: null }))).toBe('2026-05-02');
  });

  it('ignores the case of placeholders and leaves unknown ones empty', () => {
    expect(fillPattern('{DATUM} {Typ} {unbekannt} Ende', document())).toBe('2026-03-15 Rechnung Ende');
  });

  it('leaves missing values empty and trims the separators they leave at both ends', () => {
    const empty = document({ docType: null, persons: [], topicName: null, projectName: null });

    expect(fillPattern('{typ}{absender}{thema}{projekt}', empty)).toBe('');
    expect(fillPattern('{typ} - {titel} _ {absender}', empty)).toBe('Strom März');
    expect(fillPattern('_-{thema}x{projekt}-_ ', empty)).toBe('x');
  });

  it('collapses repeated whitespace but keeps single separators inside the name', () => {
    expect(fillPattern('{titel}   {typ}\t{absender}', document())).toBe('Strom März Rechnung\tStadtwerke');
    expect(fillPattern('{titel}', document({ title: 'Brief\t' }))).toBe('Brief');
  });
});
