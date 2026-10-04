import { describe, expect, it } from 'vitest';
import { MAX_LLM_PARTS } from '../../packages/core/src/services/document-parts';
import { estimateAnalysisTokens } from '../../packages/core/src/services/bulk-estimate';

const LIMIT = 20_000;

describe('estimateAnalysisTokens', () => {
  it('counts one request with its prompt and output allowance for a short text', () => {
    const tokens = estimateAnalysisTokens([1_000], LIMIT);

    expect(tokens).toBeGreaterThan(1_000 / 4 + 2_000 / 4);
    expect(tokens).toBeLessThan(2_000);
  });

  it('counts every part of a long text, up to the cap', () => {
    const one = estimateAnalysisTokens([10_000], LIMIT);
    const several = estimateAnalysisTokens([60_000], LIMIT);
    const capped = estimateAnalysisTokens([60_000_000], LIMIT);

    expect(several).toBeGreaterThan(2 * one);
    expect(capped).toBeLessThan(MAX_LLM_PARTS * (LIMIT / 4 + 2_000 / 4 + 1_000) + 1);
    expect(capped).toBeGreaterThan(MAX_LLM_PARTS * 1_000);
  });

  it('is the sum over the documents and zero for none', () => {
    expect(estimateAnalysisTokens([], LIMIT)).toBe(0);
    expect(estimateAnalysisTokens([1_000, 1_000], LIMIT)).toBe(2 * estimateAnalysisTokens([1_000], LIMIT));
  });
});
