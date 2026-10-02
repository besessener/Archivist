import { describe, expect, it } from 'vitest';
import { comparePersonNames, isNotAPersonName, isSelfReference, parsePersonName, personNameKey } from '../../packages/core/src/util/person-names';

const parsed = (raw: string) => {
  const p = parsePersonName(raw);
  return { cleanName: p.cleanName, roles: p.roles, titles: p.titles, comparisonKey: p.comparisonKey };
};

describe('parsePersonName (#28)', () => {
  it('parses all spellings of the Monika example to the same comparison key', () => {
    expect(parsed('Monika Lor-Zade')).toEqual({ cleanName: 'Monika Lor-Zade', roles: [], titles: [], comparisonKey: 'monika lor zade' });
    expect(parsed('Monika Lor-Zade (chefin)')).toEqual({ cleanName: 'Monika Lor-Zade', roles: ['Chefin'], titles: [], comparisonKey: 'monika lor zade' });
    expect(parsed('Monika Lor-Zade (Führungskraft)')).toEqual({
      cleanName: 'Monika Lor-Zade',
      roles: ['Führungskraft'],
      titles: [],
      comparisonKey: 'monika lor zade',
    });
    expect(parsed('Lor-Zade, Monika')).toEqual({ cleanName: 'Monika Lor-Zade', roles: [], titles: [], comparisonKey: 'monika lor zade' });
    expect(parsed('Dr. Monika Lor-Zade')).toEqual({ cleanName: 'Monika Lor-Zade', roles: [], titles: ['Dr.'], comparisonKey: 'monika lor zade' });
    expect(parsed('Monika')).toEqual({ cleanName: 'Monika', roles: [], titles: [], comparisonKey: 'monika' });
  });

  it('takes roles after a spaced dash or a comma', () => {
    expect(parsed('Monika Lor-Zade – Führungskraft')).toMatchObject({ cleanName: 'Monika Lor-Zade', roles: ['Führungskraft'] });
    expect(parsed('Monika Lor-Zade - Chefin')).toMatchObject({ cleanName: 'Monika Lor-Zade', roles: ['Chefin'] });
    expect(parsed('Monika Lor-Zade, Chefin')).toMatchObject({ cleanName: 'Monika Lor-Zade', roles: ['Chefin'] });
    expect(parsed('Monika, Chefin')).toMatchObject({ cleanName: 'Monika', roles: ['Chefin'] });
    expect(parsed('Monika Lor-Zade, Leiterin Einkauf')).toMatchObject({ cleanName: 'Monika Lor-Zade', roles: ['Leiterin Einkauf'] });
    expect(parsed('Lor-Zade, Monika (Chefin), Führungskraft')).toMatchObject({ cleanName: 'Monika Lor-Zade', roles: ['Chefin', 'Führungskraft'] });
    expect(parsed('Monika Lor-Zade (Chefin, Führungskraft)')).toMatchObject({ roles: ['Chefin', 'Führungskraft'] });
    expect(parsed('Monika Lor-Zade (chefin) – Chefin')).toMatchObject({ roles: ['Chefin'] });
  });

  it('distinguishes "last name, first name" from "name, role"', () => {
    expect(parsed('Schmidt, Anna Maria')).toMatchObject({ cleanName: 'Anna Maria Schmidt' });
    expect(parsed('Müller, Dr. Hans')).toMatchObject({ cleanName: 'Hans Müller', titles: ['Dr.'] });
    expect(parsed('Schmidt, CEO')).toMatchObject({ cleanName: 'Schmidt', roles: ['CEO'] });
    expect(parsed('Schmidt, Bereichsleiterin')).toMatchObject({ cleanName: 'Schmidt', roles: ['Bereichsleiterin'] });
    expect(parsed('Monika, chefin')).toMatchObject({ cleanName: 'Monika', roles: ['Chefin'] });
    expect(parsed('lor-zade, monika')).toMatchObject({ cleanName: 'monika lor-zade', comparisonKey: 'monika lor zade' });
  });

  it('removes titles and salutations', () => {
    expect(parsed('Prof. Dr. Monika Lor-Zade')).toMatchObject({ cleanName: 'Monika Lor-Zade', titles: ['Prof.', 'Dr.'] });
    expect(parsed('Frau Lor-Zade')).toMatchObject({ cleanName: 'Lor-Zade', titles: ['Frau'] });
    expect(parsed('Herr Dr.-Ing. Hans Meier')).toMatchObject({ cleanName: 'Hans Meier', titles: ['Herr', 'Dr.-Ing.'] });
    expect(parsed('Dr. med. Anna Schmidt')).toMatchObject({ cleanName: 'Anna Schmidt', titles: ['Dr.', 'med.'] });
    // a lone title is kept rather than producing an empty name
    expect(parsed('Herr')).toMatchObject({ cleanName: 'Herr' });
  });

  it('treats role words around the name as roles', () => {
    expect(parsed('Chefin Monika')).toMatchObject({ cleanName: 'Monika', roles: ['Chefin'] });
    expect(parsed('Monika Lor-Zade Teamleiterin')).toMatchObject({ cleanName: 'Monika Lor-Zade', roles: ['Teamleiterin'] });
  });

  it('ignores case, hyphen vs. space and umlaut spellings in the comparison key', () => {
    expect(parsePersonName('MONIKA LOR ZADE').comparisonKey).toBe('monika lor zade');
    expect(parsePersonName('Jürgen Müller').comparisonKey).toBe(parsePersonName('Juergen Mueller').comparisonKey);
    expect(parsePersonName('Jörg Weiß').comparisonKey).toBe(parsePersonName('Joerg Weiss').comparisonKey);
    expect(parsePersonName('Renée Ångström').comparisonKey).toBe('renee angstroem');
    expect(personNameKey('  „Monika“  ')).toBe('monika');
    expect(parsePersonName('  „Monika   Lor-Zade“ ').cleanName).toBe('Monika Lor-Zade');
  });
});

describe('isNotAPersonName / isSelfReference (#28)', () => {
  it('rejects pronouns, answer words and text without a name', () => {
    for (const w of [
      'ich',
      'Ich',
      'mir',
      'mich',
      'du',
      'ja',
      'Ja!',
      'nein',
      'unbekannt',
      'Unbekannt',
      'keiner',
      'niemand',
      'weiß nicht',
      'keine Ahnung',
      '?',
      '–',
      '42',
      'M',
      'Herr',
      'Frau',
    ])
      expect(isNotAPersonName(w), w).toBe(true);
    for (const n of ['Monika', 'Monika Lor-Zade (chefin)', 'Jan', 'Ida', 'Jo Meier']) expect(isNotAPersonName(n), n).toBe(false);
  });

  it('recognises self references', () => {
    for (const w of ['ich', 'Ich selbst', 'mir', 'mich', 'mein', 'me']) expect(isSelfReference(w), w).toBe(true);
    for (const w of ['du', 'ja', 'Monika']) expect(isSelfReference(w), w).toBe(false);
  });
});

describe('comparePersonNames (#26/#27)', () => {
  it('reports unambiguous duplicates as same', () => {
    const forms = [
      'Monika Lor-Zade',
      'Monika Lor-Zade (chefin)',
      'Monika Lor-Zade (Führungskraft)',
      'Lor-Zade, Monika',
      'Dr. Monika Lor-Zade',
      'monika lor zade',
    ];
    for (const f of forms) expect(comparePersonNames(f, 'Monika Lor-Zade'), f).toBe('same');
  });

  it('classifies unclear pairs', () => {
    expect(comparePersonNames('Monika', 'Monika Lor-Zade')).toBe('first_name_only');
    expect(comparePersonNames('Monika Lor-Zade', 'Monika')).toBe('first_name_only');
    expect(comparePersonNames('Lor-Zade', 'Monika Lor-Zade')).toBe('last_name_only');
    expect(comparePersonNames('Frau Lor-Zade', 'Monika Lor-Zade')).toBe('last_name_only');
    expect(comparePersonNames('M. Lor-Zade', 'Monika Lor-Zade')).toBe('initial');
    expect(comparePersonNames('Monika Lor-Zade', 'M Lor-Zade')).toBe('initial');
    expect(comparePersonNames('Anna Maria Schmidt', 'Anna Schmidt')).toBe('middle_name');
    expect(comparePersonNames('Monika Lorzadeh', 'Monika Lor-Zade')).toBe('similar_spelling');
  });

  it('does not relate different persons', () => {
    expect(comparePersonNames('Anna Schmidt', 'Bernd Schmidt')).toBeNull();
    expect(comparePersonNames('Monika Lor-Zade', 'Peter Meier')).toBeNull();
    expect(comparePersonNames('X. Lor-Zade', 'Monika Lor-Zade')).toBeNull();
    expect(comparePersonNames('', 'Monika')).toBeNull();
  });
});
