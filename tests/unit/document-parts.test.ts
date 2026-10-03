import { describe, expect, it } from 'vitest';
import type { DocumentClassification } from '@archivist/shared';
import { MAX_LLM_PARTS, mergeParts, partSize, splitIntoParts } from '../../packages/core/src/services/document-parts';

const result = (fields: Partial<DocumentClassification>): DocumentClassification => ({
  docType: 'Protokoll',
  title: 'T',
  summary: 'S',
  persons: [],
  dates: [],
  tags: [],
  location: { categoryPath: 'work/x', fileName: null, newMainCategory: false, rationale: '', confidence: 0.7 },
  decisions: [],
  openItems: [],
  confidence: 0.7,
  rationale: '',
  ...fields,
});

describe('splitIntoParts', () => {
  it('keeps a short text as one part', () => {
    expect(splitIntoParts('kurz', 100)).toEqual(['kurz']);
  });

  it('cuts at line breaks and loses no text up to the cap', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Zeile ${i}`).join('\n');

    const parts = splitIntoParts(text, 50);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 50)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('stops at the maximum number of parts', () => {
    expect(splitIntoParts('x'.repeat(1000), 10)).toHaveLength(MAX_LLM_PARTS);
  });
});

describe('partSize', () => {
  it('leaves room for the prompt and never goes below a useful minimum', () => {
    expect(partSize({ maxInputChars: 24_000, promptChars: 1000 })).toBeLessThan(23_000);
    expect(partSize({ maxInputChars: 600, promptChars: 900 })).toBe(500);
  });
});

describe('mergeParts', () => {
  it("takes the first part's classification and the distinct findings of all parts", () => {
    const decision = { title: 'A', decisionText: 'Es wird gebaut.', participants: [] };
    const merged = mergeParts([
      result({ title: 'Erster', persons: ['Anna Berg'], tags: ['bau'], decisions: [decision], openItems: [{ title: 'Budget klären' }] }),
      result({ title: 'Zweiter', persons: ['anna berg', 'Ben Roth'], tags: ['bau', 'haus'], decisions: [decision], openItems: [{ title: 'Termin' }] }),
    ]);

    expect(merged.title).toBe('Erster');
    expect(merged.persons).toEqual(['Anna Berg', 'Ben Roth']);
    expect(merged.tags).toEqual(['bau', 'haus']);
    expect(merged.decisions).toHaveLength(1);
    expect(merged.openItems.map((o) => o.title)).toEqual(['Budget klären', 'Termin']);
  });
});
