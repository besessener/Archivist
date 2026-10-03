import { describe, expect, it } from 'vitest';
import { isUndecidedWording, mentionsDecision } from '../../packages/core/src/util/decision-language';
import { detectOpenItemSentences } from '../../packages/core/src/services/open-items';
import { personsInHeaderLines, topicFromFolder } from '../../packages/core/src/services/local-extraction';

describe('people on header lines', () => {
  it('reads attendee lists with roles and conjunctions', () => {
    expect(personsInHeaderLines('Teilnehmer: Anna Berg (Leitung), Ben Roth und Carla Neu')).toEqual(['Anna Berg', 'Ben Roth', 'Carla Neu']);
    expect(personsInHeaderLines('Present: Dr. Eva Lang & Tom Fry')).toEqual(['Eva Lang', 'Tom Fry']);
  });

  it('reads the sender of a mail without the address and ignores bare addresses', () => {
    expect(personsInHeaderLines('Von: Carla Neu <carla@example.org>\nAn: x@example.org')).toEqual(['Carla Neu']);
    expect(personsInHeaderLines('Von: carla@example.org')).toEqual([]);
  });

  it('takes nothing from running text or from words that are no names', () => {
    expect(personsInHeaderLines('Anna Berg hat gestern angerufen.\nTeilnehmer: alle, keine, 12 Personen')).toEqual([]);
  });
});

describe('topic from a folder name', () => {
  it('names a topic by a specific folder and skips generic ones', () => {
    expect(topicFromFolder('Hausbau_Bern')).toBe('Hausbau Bern');
    expect(topicFromFolder('Downloads')).toBeNull();
    expect(topicFromFolder('2026')).toBeNull();
    expect(topicFromFolder('')).toBeNull();
  });
});

describe('English wording', () => {
  it('recognises decisions and leaves undecided sentences out', () => {
    expect(mentionsDecision('We decided to move the launch.')).toBe(true);
    expect(mentionsDecision('Decision: the budget is approved.')).toBe(true);
    expect(isUndecidedWording('We have not decided yet whether to move the launch.')).toBe(true);
    expect(isUndecidedWording('We decided to move the launch.')).toBe(false);
  });

  it('recognises open items', () => {
    expect(detectOpenItemSentences('The budget is still to be confirmed.\nAction item: call the bank.\nAll good here.')).toEqual([
      'The budget is still to be confirmed.',
      'Action item: call the bank.',
    ]);
  });
});
