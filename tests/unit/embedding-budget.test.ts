import { describe, expect, it } from 'vitest';
import { withinCharBudget } from '../../packages/core/src/services/llm/embedding-budget';

const total = (texts: string[]) => texts.reduce((sum, text) => sum + text.length, 0);

describe('withinCharBudget', () => {
  it('passes everything through when the total is below the limit', () => {
    expect(withinCharBudget(['aaaa', 'bbbb'], 9)).toEqual(['aaaa', 'bbbb']);
  });

  it('keeps everything when the total is exactly the limit', () => {
    expect(withinCharBudget(['aaaa', 'bbbb'], 8)).toEqual(['aaaa', 'bbbb']);
  });

  it('leaves out the text that would exceed the limit by one character, and all after it', () => {
    expect(withinCharBudget(['aaaa', 'bbbb', 'c'], 7)).toEqual(['aaaa']);
  });

  it('does not pick up a later text that would still fit after an earlier one was left out', () => {
    expect(withinCharBudget(['aaaa', 'bbbbbbbb', 'c'], 6)).toEqual(['aaaa']);
  });

  it('cuts a first text that alone exceeds the limit, so the entry still gets a vector', () => {
    expect(withinCharBudget(['abcdefghij', 'klm'], 4)).toEqual(['abcd']);
  });

  it('keeps a first text that is exactly the limit', () => {
    expect(withinCharBudget(['abcd', 'e'], 4)).toEqual(['abcd']);
  });

  it('never cuts a later text, only the first', () => {
    expect(withinCharBudget(['ab', 'cdefgh'], 5)).toEqual(['ab']);
  });

  it('counts the title prefix of every chunk like any other character', () => {
    const chunks = ['Titel\nerster Abschnitt', 'Titel\nzweiter Abschnitt', 'Titel\ndritter Abschnitt'];
    const limit = chunks[0]!.length + chunks[1]!.length;
    expect(withinCharBudget(chunks, limit)).toEqual([chunks[0], chunks[1]]);
    expect(withinCharBudget(chunks, limit - 1)).toEqual([chunks[0]]);
  });

  it('never exceeds the limit for many chunks of document size', () => {
    const chunks = Array.from({ length: 50 }, (_, index) => `Titel\n${String(index).repeat(900)}`);
    const sent = withinCharBudget(chunks, 2000);
    expect(total(sent)).toBeLessThanOrEqual(2000);
    expect(sent).toEqual(chunks.slice(0, sent.length));
    expect(sent.length).toBeGreaterThan(0);
  });

  it('does not leave half of a surrogate pair at the cut', () => {
    expect(withinCharBudget(['ab😀cd'], 3)).toEqual(['ab']);
    expect(withinCharBudget(['ab😀cd'], 4)).toEqual(['ab😀']);
  });

  it('returns nothing for no texts or a limit of zero', () => {
    expect(withinCharBudget([], 100)).toEqual([]);
    expect(withinCharBudget(['abc'], 0)).toEqual([]);
  });
});
