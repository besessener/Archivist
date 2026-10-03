import type { Decision } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import { chosenOption, compareLexically, polarity, relatedPairs, sharesContent, sharesScope } from '../../packages/core/src/services/contradiction-rules';

describe('polarity of a decision text', () => {
  it.each([
    'Wir wollen das Projekt nicht fortsetzen',
    'Wir wollen das Projekt nicht  fortsetzen',
    'Wir wollen das Projekt nicht mehr fortsetzen',
    'Wir wollen das Projekt nicht mehr  fortsetzen',
    'Das Projekt wird nicht weiterentwickeln',
    'Wir pausieren das Projekt',
    'Wir einstellen das Projekt',
    'Das Projekt wird eingestellt',
    'Wir stoppen das Projekt',
    'Wir beenden das Projekt',
    'Wir abbrechen das Projekt',
    'Das Projekt wurde abgebrochen',
    'Wir aussetzen das Projekt',
    'Wir zurückstellen das Projekt',
    'Wir verwerfen den Plan',
    'Wir absagen den Termin',
    'Das Projekt gilt vorerst  nicht',
    'Das Projekt gilt erstmal nicht',
    'Das Projekt gilt erstmal  nicht',
    'Das Projekt liegt auf Eis',
    'Das Projekt liegt auf  Eis',
    'Es gibt keine weiteren Schritte',
    'Es gibt kein  weiteres Budget',
    'Für das Projekt gibt es kein Weiter',
    'Wir stellen das Projekt ein',
    'Wir brechen das Projekt ab',
    'Wir setzen das Projekt aus',
    'Wir geben das Projekt auf',
  ])('reads „%s“ as stop', (text) => {
    expect(polarity(text)).toBe('stop');
  });

  it.each([
    'Wir führen das Projekt weiter',
    'Wir fuehren das Projekt weiter',
    'Wir machen mit dem Projekt weiter',
    'Wir verfolgen das Projekt weiter',
    'Die Entwicklung geht weiter',
    'Wir setzen das Projekt um',
    'Wir nehmen das Projekt wieder auf',
    'Wir nehmen das Projekt wieder  auf',
    'Wir reaktivieren das Projekt',
  ])('reads „%s“ as go', (text) => {
    expect(polarity(text)).toBe('go');
  });

  it.each([
    'Wir stellen fest. Ein Ergebnis fehlt.',
    'Wir brechen. Ab morgen',
    'Wir setzen. Aus Gründen',
    'Wir geben. Auf jeden Fall',
    'Wir führen. Weiter geht es',
  ])('needs the separable verb parts in the same sentence: „%s“', (text) => {
    expect(polarity(text)).toBeNull();
  });
});

describe('chosen option of a decision', () => {
  it.each([
    ['Wir entscheiden uns für Postgres', 'Postgres'],
    ['Wir entscheiden  uns für Postgres', 'Postgres'],
    ['Wir entschieden letzte Woche für Postgres', 'Postgres'],
    ['Wir entschieden für  Postgres', 'Postgres'],
    ['Wir entschieden für das  Produkt', 'Produkt'],
    ['Wir entschieden für das Produkt', 'Produkt'],
    ['Wir entschieden für die Cloud', 'Cloud'],
    ['Wir entschieden für die  Cloud', 'Cloud'],
    ['Wir entschieden für den Server', 'Server'],
    ['Wir entschieden für den  Server', 'Server'],
    ['Wir bleiben bei dem Anbieter', 'Anbieter'],
    ['Wir bleiben bei dem  Anbieter', 'Anbieter'],
    ['Wir entschieden für Microsoft Teams', 'Microsoft Teams'],
    ['Wir entschieden für Microsoft  Teams', 'Microsoft  Teams'],
  ])('finds the option in „%s“', (text, option) => {
    expect(chosenOption(text)).toBe(option);
  });

  it('finds no option without a choice', () => {
    expect(chosenOption('Das Budget beträgt 5000 Euro.')).toBeNull();
  });
});

describe('lexical comparison of two decisions', () => {
  it('reports opposite polarities as a conflict, naming the direction', () => {
    expect(compareLexically('Wir führen das Projekt weiter', 'Wir stoppen das Projekt')).toEqual({
      conflict: true,
      reason: 'Eine Entscheidung führt das Thema weiter, die andere stoppt oder pausiert es.',
      confidence: 0.75,
    });
    expect(compareLexically('Wir stoppen das Projekt', 'Wir führen das Projekt weiter')).toEqual({
      conflict: true,
      reason: 'Eine Entscheidung stoppt oder pausiert das Thema, die andere führt es weiter.',
      confidence: 0.75,
    });
  });

  it('reports different choices as a conflict', () => {
    expect(compareLexically('Wir entscheiden uns für Postgres', 'Wir entscheiden uns für MySQL')).toEqual({
      conflict: true,
      reason: 'Unterschiedliche Auswahl: „Postgres“ vs. „MySQL“.',
      confidence: 0.55,
    });
  });

  it('sees no conflict in the same or an overlapping choice, or the same polarity', () => {
    const noConflict = { conflict: false, reason: '', confidence: 0 };

    expect(compareLexically('Wir entscheiden uns für Postgres.', 'Wir entscheiden uns für postgres.')).toEqual(noConflict);
    expect(compareLexically('Wir entscheiden uns für Postgres Cloud.', 'Wir entscheiden uns für Postgres.')).toEqual(noConflict);
    expect(compareLexically('Wir entscheiden uns für Postgres.', 'Wir entscheiden uns für Postgres Cloud.')).toEqual(noConflict);
    expect(compareLexically('Wir stoppen das Projekt', 'Wir beenden das Projekt')).toEqual(noConflict);
    expect(compareLexically('Wir stoppen das Projekt', 'Das Budget beträgt 5000 Euro.')).toEqual(noConflict);
    expect(compareLexically('Das Budget beträgt 5000 Euro.', 'Wir führen das Projekt weiter')).toEqual(noConflict);
  });

  it('cannot judge texts without polarity and with at most one choice', () => {
    expect(compareLexically('Das Budget beträgt 5000 Euro.', 'Die Miete steigt.')).toBeNull();
    expect(compareLexically('Wir entscheiden uns für Postgres.', 'Die Miete steigt.')).toBeNull();
    expect(compareLexically('Die Miete steigt.', 'Wir entscheiden uns für Postgres.')).toBeNull();
  });
});

describe('negations in the polarity (#179)', () => {
  it.each([
    'Wir führen das Projekt nicht weiter',
    'Wir setzen das Projekt nicht fort',
    'Wir starten das Projekt nicht',
    'Wir verfolgen das Projekt nicht mehr weiter',
    'Wir setzen den Plan nicht um',
  ])('reads „%s“ as stop', (text) => {
    expect(polarity(text)).toBe('stop');
  });

  it.each(['Nicht pausieren, sondern weitermachen', 'Wir stoppen das Projekt nicht', 'Wir beenden das Projekt nicht, sondern führen es weiter'])(
    'reads „%s“ as go',
    (text) => {
      expect(polarity(text)).toBe('go');
    },
  );

  it('lets the part after „sondern“ decide', () => {
    expect(polarity('Nicht weitermachen, sondern pausieren')).toBe('stop');
  });

  it.each([
    'Wir stellen einen neuen Entwickler ein',
    'Wir stellen zwei Mitarbeiter ein',
    'Wir geben die Bestellung für den Server auf',
    'Wir geben eine Anzeige auf',
    'Wir werden einen Entwickler einstellen',
  ])('does not read hiring or ordering in „%s“ as stop', (text) => {
    expect(polarity(text)).toBeNull();
  });

  it('finds the README case „weiterführen“ against „nicht weiterführen“ as a conflict', () => {
    expect(compareLexically('Wir wollen das Projekt weiterführen', 'Wir wollen das Projekt nicht weiterführen')).toMatchObject({ conflict: true });
    expect(compareLexically('Wir führen das Projekt weiter', 'Wir führen das Projekt nicht weiter')).toMatchObject({ conflict: true });
  });
});

const decision = (fields: Partial<Decision> & { id: string }): Decision => ({ topicId: null, projectId: null, ...fields }) as Decision;

describe('which decisions are compared', () => {
  it('compares decisions of the same topic or project, also across the other scope', () => {
    const a = decision({ id: 'a', topicId: 't1', projectId: 'p1' });
    const b = decision({ id: 'b', topicId: 't2', projectId: 'p1' });
    const c = decision({ id: 'c', topicId: 't1', projectId: null });
    const d = decision({ id: 'd', topicId: 't3', projectId: 'p9' });
    const e = decision({ id: 'e' });

    expect(sharesScope(a, b)).toBe(true);
    expect(sharesScope(a, c)).toBe(true);
    expect(sharesScope(a, d)).toBe(false);
    expect(sharesScope(e, decision({ id: 'f' }))).toBe(false);
    expect(
      relatedPairs([a, b, c, d, e])
        .map(([x, y]) => [x.id, y.id].sort().join(''))
        .sort(),
    ).toEqual(['ab', 'ac']);
  });

  it('lists a pair that shares topic and project only once', () => {
    const a = decision({ id: 'a', topicId: 't', projectId: 'p' });
    const b = decision({ id: 'b', topicId: 't', projectId: 'p' });

    expect(relatedPairs([a, b])).toHaveLength(1);
  });

  it('sees shared content words but ignores stop words and short words', () => {
    expect(sharesContent('Das Meeting findet dienstags statt', 'Das Meeting wird verschoben')).toBe(true);
    expect(sharesContent('Das Meeting findet dienstags statt', 'Das Protokoll schreibt Anna')).toBe(false);
  });
});
