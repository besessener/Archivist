import { describe, expect, it } from 'vitest';
import { hintTokens, matchOpenItems } from '../../packages/core/src/services/open-items';

const items = (...titles: string[]) => titles.map((title) => ({ title, description: null as string | null }));
const titlesOf = (r: ReturnType<typeof matchOpenItems>) =>
  r.status === 'match' ? [r.item.title] : r.status === 'ambiguous' ? r.items.map((i) => i.title).sort() : [];

describe('matchOpenItems (#39)', () => {
  it.each([
    ['Server', ['Steuer'], 'none', []],
    ['Vertrag', ['Vertrag prüfen', 'Vertrag kündigen'], 'ambiguous', ['Vertrag kündigen', 'Vertrag prüfen']],
    ['Der PoC ist erledigt, schließ den Punkt bitte', ['PoC vorstellen'], 'match', ['PoC vorstellen']],
    ['TÜV', ['Auto zum TÜV bringen'], 'match', ['Auto zum TÜV bringen']],
    ['Präsi Kunde X', ['Präsentation für Kunde X vorbereiten'], 'match', ['Präsentation für Kunde X vorbereiten']],
    ['Zahnarzt', ['Zahnarzt anrufen', 'Budget planen', 'Angebot für Müller prüfen'], 'match', ['Zahnarzt anrufen']],
    ['Budget', ['Zahnarzt anrufen', 'Budget planen', 'Angebot für Müller prüfen'], 'match', ['Budget planen']],
    ['Müller-Angebot', ['Zahnarzt anrufen', 'Budget planen', 'Angebot für Müller prüfen'], 'match', ['Angebot für Müller prüfen']],
    ['Die Steuererklärung ist erledigt', ['PoC vorstellen'], 'none', []],
    ['schließ den Punkt', ['PoC vorstellen'], 'none', []],
  ])('„%s“ in %j → %s', (hint, titles, status, expected) => {
    const r = matchOpenItems({ hint, items: items(...titles) });
    expect(r.status).toBe(status);
    expect(titlesOf(r)).toEqual(expected);
  });

  it('also searches the description', () => {
    const r = matchOpenItems({
      hint: 'Rabatt',
      items: [
        { title: 'Angebot prüfen', description: 'Müller wollte Rabatt' },
        { title: 'Zahnarzt anrufen', description: null },
      ],
    });
    expect(titlesOf(r)).toEqual(['Angebot prüfen']);
  });

  it('a title match beats a match in the description only', () => {
    const r = matchOpenItems({
      hint: 'Rabatt',
      items: [
        { title: 'Rabatt verhandeln', description: null },
        { title: 'Angebot prüfen', description: 'Müller wollte Rabatt' },
      ],
    });
    expect(titlesOf(r)).toEqual(['Rabatt verhandeln']);
  });
});

describe('hintTokens (#40)', () => {
  it.each([
    ['Erinnere mich in sieben Tagen wieder daran', []],
    ['Der Punkt ist erledigt', []],
    ['Erinnere mich am 15.11. an den Zahnarzt', ['zahnarzt']],
    ['Die Steuererklärung ist erledigt', ['steuererklarung']],
  ])('%s → %j', (hint, expected) => {
    expect(hintTokens(hint)).toEqual(expected);
  });
});
