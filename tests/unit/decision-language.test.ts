import { describe, expect, it } from 'vitest';
import { isExplicitDecision, isUndecidedWording } from '../../packages/core/src/util/decision-language';
import { classifyLocally } from '../../packages/core/src/services/classifier';

describe('decision wording without an LLM (#176)', () => {
  it.each([
    'Es wurde noch nicht entschieden, ob wir umziehen.',
    'Ob wir umziehen, ist unentschieden.',
    'Die Entscheidung ist vertagt.',
    'Wir haben keine Entscheidung getroffen.',
  ])('treats "%s" as undecided', (sentence) => {
    expect(isUndecidedWording(sentence)).toBe(true);
    expect(isExplicitDecision(sentence)).toBe(false);
  });

  it('trusts only the explicit first-person wording', () => {
    expect(isExplicitDecision('Wir haben am 03.03.2026 mit Phoenix entschieden: Pause.')).toBe(true);
    expect(isExplicitDecision('Entscheidung: Wir nehmen Variante A.')).toBe(true);
    expect(isExplicitDecision('Das wurde beschlossen.')).toBe(false);
  });

  it('ignores undecided sentences when reading a document', () => {
    const result = classifyLocally({
      fileName: 'protokoll.txt',
      ext: 'txt',
      text: 'Es wurde noch nicht entschieden, ob wir umziehen. Beschluss: Das Budget beträgt 5000 Euro.',
      knownTopics: [],
      knownProjects: [],
      now: new Date('2026-05-01'),
    });
    expect(result.possibleDecisions.map((d) => d.decisionText)).toEqual(['Beschluss: Das Budget beträgt 5000 Euro.']);
  });

  it('keeps explicit decisions when the cap cuts off looser sentences', () => {
    const loose = Array.from({ length: 6 }, (_, i) => `Das Thema ${i} wurde beschlossen.`).join(' ');
    const result = classifyLocally({
      fileName: 'protokoll.txt',
      ext: 'txt',
      text: `${loose} Beschluss: Das Budget beträgt 5000 Euro.`,
      knownTopics: [],
      knownProjects: [],
      now: new Date('2026-05-01'),
    });
    expect(result.possibleDecisions).toHaveLength(5);
    expect(result.possibleDecisions[0]!.decisionText).toBe('Beschluss: Das Budget beträgt 5000 Euro.');
  });
});
