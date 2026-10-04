import { describe, expect, it } from 'vitest';
import { relevantNames } from '../../packages/core/src/services/relevant-names';

describe('relevantNames', () => {
  const many = Array.from({ length: 100 }, (_, i) => `Thema ${String(i).padStart(3, '0')}`);

  it('returns all names when they fit the limit', () => {
    expect(relevantNames(['B', 'A'], { text: 'x', limit: 40 })).toEqual(['B', 'A']);
  });

  it('puts names that occur in the text first, wherever they sit in the list', () => {
    const names = [...many, 'Zwiebelzucht', 'Gartenbau Nord'];

    const listed = relevantNames(names, { text: 'Protokoll zur Zwiebelzucht im Gartenbau', limit: 5 });

    expect(listed.slice(0, 2).sort()).toEqual(['Gartenbau Nord', 'Zwiebelzucht']);
    expect(listed).toHaveLength(5);
  });

  it('keeps the original order among equally relevant names', () => {
    expect(relevantNames(many, { text: 'ohne Treffer', limit: 3 })).toEqual(['Thema 000', 'Thema 001', 'Thema 002']);
  });
});
