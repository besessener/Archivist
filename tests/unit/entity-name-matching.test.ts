import { describe, expect, it } from 'vitest';
import { classifyNames } from '../../packages/core/src/services/cleanup/entity-name-matching';

const classify = (a: string, b: string, aliases: { a?: string[]; b?: string[] } = {}) =>
  classifyNames({ name: a, aliases: aliases.a }, { name: b, aliases: aliases.b });
const both = (a: string, b: string) => [classify(a, b), classify(b, a)];

describe('classifyNames spelling', () => {
  it('equates umlauts with their transliteration and separators with none', () => {
    expect(both('Müller', 'Mueller')).toEqual(['spelling', 'spelling']);
    expect(both('Köln', 'Koeln')).toEqual(['spelling', 'spelling']);
    expect(both('Bär', 'Baer')).toEqual(['spelling', 'spelling']);
    expect(both('Gruppe A', 'GruppeA')).toEqual(['spelling', 'spelling']);
    expect(both('Steuer Erklärung', 'steuer-erklaerung')).toEqual(['spelling', 'spelling']);
  });

  it('equates the same words in another order', () => {
    expect(both('Anna Schmidt', 'Schmidt Anna')).toEqual(['spelling', 'spelling']);
    expect(classify('Anna', 'Anna')).toBe('spelling');
  });

  it('keeps names with different numbers apart, however the digits are grouped', () => {
    expect(classify('Jahr 12', 'Jahr 1 2')).toBeNull();
    expect(classify('Jahr 2026', 'Jahr 2062')).toBeNull();
    expect(classify('Rechnung 7', 'Rechnung 8')).toBeNull();
  });

  it('knows nothing about a name without letters or digits', () => {
    expect(classify('', 'Anna')).toBeNull();
    expect(classify('Anna', '')).toBeNull();
    expect(classify('!!!', 'Anna')).toBeNull();
    expect(classify('', '')).toBeNull();
  });
});

describe('classifyNames aliases', () => {
  it('finds a name among the aliases of either side', () => {
    expect(classify('Anna', 'Anne', { b: ['Anna'] })).toBe('alias');
    expect(classify('Anna', 'Anne', { a: ['Anne'] })).toBe('alias');
    expect(classify('Anna', 'Berta', { a: ['Anna', 'Carla'], b: ['Dora'] })).toBeNull();
    expect(classify('Anna', 'Berta', { a: ['Dora'], b: ['Eva'] })).toBeNull();
  });

  it('compares aliases normalized and only against the other name', () => {
    expect(classify('Müller', 'Meier', { b: ['MÜLLER'] })).toBe('alias');
    expect(classify('Anna Maria', 'Berta', { a: ['Berta'] })).toBe('alias');
    expect(classify('Anna Maria', 'Berta', { b: ['Berta'] })).toBeNull();
  });
});

describe('classifyNames plurals', () => {
  it.each([
    ['Tisch', 'Tische'],
    ['Tag', 'Tage'],
    ['Auto', 'Autos'],
    ['Kind', 'Kinder'],
    ['Bus', 'Buses'],
    ['Frau', 'Frauen'],
    ['Biene', 'Bienen'],
    ['Hobby', 'Hobbies'],
    ['Datei', 'Dateinen'],
  ])('%s and %s are plurals, whichever comes first', (singular, plural) => {
    expect(both(singular, plural)).toEqual(['plural', 'plural']);
  });

  it('wants three letters, a plural ending and the y-to-ies rule only for y', () => {
    expect(both('Ab', 'Abs')).toEqual([null, null]);
    expect(both('Hobby', 'Hobbyfoo')).toEqual([null, null]);
    expect(both('Hobby', 'Hobbyies')).toEqual([null, null]);
    expect(both('Tisch', 'Tischxy')).toEqual([null, null]);
  });
});

describe('classifyNames typos', () => {
  it('tolerates one edit from six letters and two from eleven', () => {
    expect(both('abcdef', 'abcdxf')).toEqual(['typo', 'typo']);
    expect(both('abcde', 'abcdx')).toEqual([null, null]);
    expect(both('abcdefghij', 'abcdefghxx')).toEqual([null, null]);
    expect(both('abcdefghijk', 'abcdefghixx')).toEqual(['typo', 'typo']);
    expect(both('abcdefghijk', 'abcdefghxxx')).toEqual([null, null]);
  });

  it('measures the allowance by the longer word', () => {
    expect(both('abcdefghij', 'abcdefghijkl')).toEqual(['typo', 'typo']);
    expect(both('abcdef', 'abcdefg')).toEqual(['typo', 'typo']);
    expect(both('abcdef', 'abcdefghi')).toEqual([null, null]);
  });

  it('counts swapped neighbours as one edit, but not two swaps', () => {
    expect(both('abcdef', 'abdcef')).toEqual(['typo', 'typo']);
    expect(both('abcdef', 'bacdef')).toEqual(['typo', 'typo']);
    expect(both('abcdef', 'badcef')).toEqual([null, null]);
    expect(both('abcdefghijk', 'badcefghijk')).toEqual(['typo', 'typo']);
  });

  it('compares multi-word names word by word', () => {
    expect(both('Gruppe A', 'Gruppe B')).toEqual([null, null]);
    expect(both('Steuererklaerung Anna', 'Steuererklaerng Anna')).toEqual(['typo', 'typo']);
    expect(both('Steuererklaerung Anna', 'Steuererklaerng Anne')).toEqual([null, null]);
    expect(both('Steuererklaerung Anna', 'Steuererklaerng Berta')).toEqual([null, null]);
    expect(both('Steuererklaerung Anna', 'Steuererklaerng Annx Z')).toEqual([null, null]);
  });

  it('compares a single word against a two-word name without separators', () => {
    expect(both('Steuererklaerung', 'Steuer Erklaerng')).toEqual(['typo', 'typo']);
    expect(both('abcdef', 'abc dxf')).toEqual(['typo', 'typo']);
  });
});

describe('classifyNames prefixes', () => {
  it('matches a name that continues the other by one or two words', () => {
    expect(both('Urlaub', 'Urlaub 2026')).toEqual(['prefix', 'prefix']);
    expect(both('Urlaub', 'Urlaub Italien Sommer')).toEqual(['prefix', 'prefix']);
    expect(both('Urlaub', 'Urlaub Italien Sommer 2026')).toEqual([null, null]);
    expect(both('Urlaub Italien', 'Urlaub Italien Sommer')).toEqual(['prefix', 'prefix']);
  });

  it('wants four letters in the shorter name and the same start', () => {
    expect(both('Tax', 'Tax 2026')).toEqual([null, null]);
    expect(both('Reis', 'Reis 2026')).toEqual(['prefix', 'prefix']);
    expect(both('Italien Urlaub', 'Urlaub Italien Sommer')).toEqual([null, null]);
    expect(both('Urlaub Italien', 'Urlaub Spanien Sommer')).toEqual([null, null]);
    expect(both('Urlaub Italien', 'Ferien Italien Sommer')).toEqual([null, null]);
  });
});
