import { describe, expect, it } from 'vitest';
import { settingsChanges } from '../../packages/core/src/services/settings-changes';

describe('settingsChanges', () => {
  it('lists only the differing values as dotted paths', () => {
    const before = { archiveRoot: '/a', privacy: { llmMode: 'confirm', neverAnalyzeDirs: [] }, llm: { baseUrl: 'x' } };
    const after = { archiveRoot: '/b', privacy: { llmMode: 'auto', neverAnalyzeDirs: [] }, llm: { baseUrl: 'x' } };
    expect(settingsChanges(before, after)).toEqual({
      before: { archiveRoot: '/a', 'privacy.llmMode': 'confirm' },
      after: { archiveRoot: '/b', 'privacy.llmMode': 'auto' },
    });
  });

  it('compares lists as a whole and reports added and removed values', () => {
    expect(settingsChanges({ privacy: { dirs: ['a'] } }, { privacy: { dirs: ['a', 'b'] } })).toEqual({
      before: { 'privacy.dirs': ['a'] },
      after: { 'privacy.dirs': ['a', 'b'] },
    });
    expect(settingsChanges({ a: 1 }, { b: 2 })).toEqual({ before: { a: 1, b: null }, after: { a: null, b: 2 } });
  });

  it('is empty when nothing changed', () => {
    expect(settingsChanges({ a: { b: [1] } }, { a: { b: [1] } })).toEqual({ before: {}, after: {} });
  });
});
