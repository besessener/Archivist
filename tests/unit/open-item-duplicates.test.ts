import { describe, expect, it } from 'vitest';
import { assessOpenItemPair, findOpenItemDuplicate } from '../../packages/core/src/services/cleanup/open-item-duplicates';
import { appendText, chooseKept, duplicatePairKey, takeOverMissing, titleSimilarity } from '../../packages/core/src/services/cleanup/record-merge';

describe('assessOpenItemPair (#35)', () => {
  it.each([
    ['Angebot für Müller prüfen', 'Angebot Müller prüfen', true],
    ['Präsentation Kunde X vorbereiten', 'Präsentation für Kunde X vorbereiten', true],
    ['Steuererklärung abgeben', 'Steuererklaerung abgeben', true],
    ['Vertrag prüfen', 'Vertrag kündigen', false],
    ['Zahnarzt anrufen', 'Zahnarzt Termin vereinbaren', false],
    ['Budget 2026 planen', 'Budget 2027 planen', false],
    ['Budget planen', 'Steuer planen', false],
  ])('„%s“ / „%s“ → %s', (a, b, expected) => {
    expect(assessOpenItemPair({ title: a }, { title: b }).duplicate).toBe(expected);
  });

  it('abweichende Angaben (Verantwortlicher, Thema, Projekt) schließen eine Dublette aus', () => {
    const base = { title: 'Präsentation vorbereiten' };
    expect(assessOpenItemPair({ ...base, responsiblePersonId: 'p1' }, { ...base, responsiblePersonId: 'p2' })).toMatchObject({
      duplicate: false,
      conflict: true,
    });
    expect(assessOpenItemPair({ ...base, topicId: 't1' }, { ...base, topicId: 't2' }).duplicate).toBe(false);
    expect(assessOpenItemPair({ ...base, projectId: 'x' }, { ...base, projectId: 'y' }).duplicate).toBe(false);
    // only one side known: no conflict
    expect(assessOpenItemPair({ ...base, responsiblePersonId: 'p1' }, base).duplicate).toBe(true);
  });

  it('übereinstimmende Angaben und Beschreibung stützen einen nur ähnlichen Titel', () => {
    const a = { title: 'Angebot Müller prüfen', description: 'Rabatt klären' };
    const b = { title: 'Angebot Müller nachverhandeln', description: 'Rabatt klären' };
    const loose = assessOpenItemPair({ title: a.title }, { title: b.title });
    expect(loose.duplicate).toBe(false);
    const withContext = assessOpenItemPair({ ...a, topicId: 't', responsiblePersonId: 'p' }, { ...b, topicId: 't', responsiblePersonId: 'p' });
    expect(withContext).toMatchObject({ duplicate: true, reasons: ['gleiches Thema', 'gleicher Verantwortlicher', 'gleiche Beschreibung'] });
  });

  it('ist symmetrisch', () => {
    const a = { title: 'Angebot prüfen' };
    const b = { title: 'Angebot für Müller prüfen, er wollte Rabatt' };
    expect(titleSimilarity(a, b)).toBeCloseTo(titleSimilarity(b, a));
  });
});

describe('findOpenItemDuplicate (#35)', () => {
  const items = [
    { id: '1', title: 'Angebot für Müller prüfen', description: 'Rabatt klären, Konditionen vergleichen' },
    { id: '2', title: 'Zahnarzt anrufen', description: null },
  ];
  it('findet einen Entwurf, dessen Titel im bestehenden Punkt steckt', () => {
    expect(findOpenItemDuplicate({ title: 'Angebot Müller' }, items)?.id).toBe('1');
  });
  it('keine Dublette bei abweichendem Verantwortlichen oder ohne Ähnlichkeit', () => {
    expect(findOpenItemDuplicate({ title: 'Angebot Müller', responsiblePersonId: 'b' }, [{ ...items[0]!, responsiblePersonId: 'a' }])).toBeNull();
    expect(findOpenItemDuplicate({ title: 'Steuer abgeben' }, items)).toBeNull();
  });
});

describe('takeOverMissing / Hilfen zum Zusammenführen (#35, auch für Notizen/Ereignisse)', () => {
  type R = { description: string | null; dueAt: string | null; owner: string | null; sources: string[] };
  const rules = { description: 'append', dueAt: 'fill', owner: 'fill', sources: 'union' } as const;

  it('füllt nur Fehlendes, hängt Text an und vereinigt Listen', () => {
    const keep: R = { description: 'Konditionen klären', dueAt: null, owner: 'Anna', sources: ['a'] };
    const dup: R = { description: 'er wollte Rabatt', dueAt: '2026-11-15', owner: 'Bernd', sources: ['a', 'b'] };
    expect(takeOverMissing(keep, dup, rules)).toEqual({
      patch: { description: 'Konditionen klären\ner wollte Rabatt', dueAt: '2026-11-15', sources: ['a', 'b'] },
      before: { description: 'Konditionen klären', dueAt: null, sources: ['a'] },
      fields: ['description', 'dueAt', 'sources'],
    });
  });

  it('übernimmt nichts, wenn der Duplikat-Datensatz nichts Neues hat', () => {
    const keep: R = { description: 'Rabatt klären', dueAt: '2026-01-01', owner: 'Anna', sources: ['a'] };
    const dup: R = { description: 'rabatt KLÄREN', dueAt: null, owner: null, sources: [] };
    expect(takeOverMissing(keep, dup, rules).fields).toEqual([]);
  });

  it('appendText, duplicatePairKey und chooseKept', () => {
    expect(appendText(null, ' neu ')).toBe('neu');
    expect(appendText('alt', null)).toBe('alt');
    expect(appendText('Alt und neu', 'neu')).toBe('Alt und neu');
    expect(duplicatePairKey('x:', 'b', 'a')).toBe(duplicatePairKey('x:', 'a', 'b'));
    expect(duplicatePairKey('x:', 'b', 'a')).toBe('x:a|b');
    const older = { id: 'z', createdAt: '2026-01-01' };
    const newer = { id: 'a', createdAt: '2026-02-01' };
    expect(chooseKept(newer, older)).toEqual({ keep: older, duplicate: newer });
  });
});
