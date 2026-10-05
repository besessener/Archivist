import { describe, expect, it } from 'vitest';
import { readTable } from '../../apps/renderer/components/common/markdown-table';

describe('readTable', () => {
  it('reads header, body rows and the index after the table', () => {
    const lines = ['| Datei | Ordner |', '|---|---|', '| A.pptx | work/a |', '| B.pptx | work/b |', '', 'danach'];
    expect(readTable({ lines, start: 0 })).toEqual({
      block: {
        kind: 'table',
        header: ['Datei', 'Ordner'],
        rows: [
          ['A.pptx', 'work/a'],
          ['B.pptx', 'work/b'],
        ],
      },
      next: 4,
    });
  });

  it('accepts alignment colons, missing outer pipes and escaped pipes inside a cell', () => {
    const lines = ['Name | Wert', ':--- | ---:', 'a \\| b | 1'];
    expect(readTable({ lines, start: 0 })?.block).toEqual({ kind: 'table', header: ['Name', 'Wert'], rows: [['a | b', '1']] });
  });

  it('is no table without a separator row', () => {
    expect(readTable({ lines: ['| a | b |', '| c | d |'], start: 0 })).toBeUndefined();
    expect(readTable({ lines: ['ein | Satz', 'noch einer'], start: 0 })).toBeUndefined();
  });

  it('is no table when the separator has a non-dash cell', () => {
    expect(readTable({ lines: ['| a | b |', '| --- | x |'], start: 0 })).toBeUndefined();
  });
});
