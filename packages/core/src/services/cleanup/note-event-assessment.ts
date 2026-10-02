import { levenshtein, normalizeName, tokenize } from '../../util/text';
import { numbersDiffer, titleSimilarity } from './record-merge';

export interface NotePairAssessment {
  duplicate: boolean;
  /** `identical`: same text; `similar`: same words (order, punctuation, typos); `contained`: one note adds only a little. */
  match: 'identical' | 'similar' | 'contained' | null;
  /** Share of words both notes have in common (0..1). */
  similarity: number;
}

/** A longer note may add at most this share of words to a shorter one to count as the same note. */
const CONTAINED_MIN_RATIO = 0.8;

export const words = (text: string) => [...new Set(tokenize(text, { keepStopwords: true }))];
/** Typos tolerated per word: none in short words, one from five letters on, two (e.g. swapped letters) from eight on. */
const typos = (word: string) => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0);
/** A word is found if it occurs as is or with a few typos. */
const found = (word: string, list: string[]) =>
  list.includes(word) || (typos(word) > 0 && list.some((other) => levenshtein(word, other) <= Math.min(typos(word), typos(other))));
/** An added negation turns a note into its opposite. */
const NEGATIONS = new Set(['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'nie', 'niemals', 'ohne', 'not', 'no', 'never']);
const numbers = (text: string) => new Set(text.match(/\d+/g) ?? []);
const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

/** Same note: identical text, the same words (order, punctuation, typos aside) or one adds very little; stopwords count. */
export function assessNotePair(a: string, b: string): NotePairAssessment {
  const normalizedA = normalizeName(a);
  const normalizedB = normalizeName(b);
  if (!normalizedA || !normalizedB) return { duplicate: false, match: null, similarity: 0 };
  if (normalizedA === normalizedB) return { duplicate: true, match: 'identical', similarity: 1 };
  const wordsA = words(a);
  const wordsB = words(b);
  const missingInB = wordsA.filter((w) => !found(w, wordsB));
  const missingInA = wordsB.filter((w) => !found(w, wordsA));
  const similarity = (wordsA.length - missingInB.length + wordsB.length - missingInA.length) / (wordsA.length + wordsB.length || 1);
  const numbersA = numbers(a);
  const numbersB = numbers(b);
  if (!missingInA.length && !missingInB.length) {
    const same = subset(numbersA, numbersB) && subset(numbersB, numbersA);
    return { duplicate: same, match: same ? 'similar' : null, similarity };
  }
  if (missingInA.length && missingInB.length) return { duplicate: false, match: null, similarity };
  if ([...missingInA, ...missingInB].some((w) => NEGATIONS.has(w))) return { duplicate: false, match: null, similarity };
  // one note contains all words of the other: the same note only if the longer one adds very little
  const [short, long, shortNumbers, longNumbers] = missingInB.length ? [wordsB, wordsA, numbersB, numbersA] : [wordsA, wordsB, numbersA, numbersB];
  const contained = short.length >= 3 && short.length / long.length >= CONTAINED_MIN_RATIO && subset(shortNumbers, longNumbers);
  return { duplicate: contained, match: contained ? 'contained' : null, similarity };
}

export interface EventDraft {
  title: string;
  occurredAt: string;
  topicId?: string | null;
  projectId?: string | null;
}

export interface EventPairAssessment {
  duplicate: boolean;
  /** Title similarity (0..1). */
  similarity: number;
  /** German reasons for the insight text, e.g. „gleiches Thema“. */
  reasons: string[];
}

const EVENT_MIN_SIMILARITY = 0.7;

/** Same event: same day and a similar title; differing details set on both sides (time, topic, project, numbers) rule it out. */
export function assessEventPair(a: EventDraft, b: EventDraft): EventPairAssessment {
  const reasons: string[] = [];
  if (a.occurredAt.slice(0, 10) !== b.occurredAt.slice(0, 10)) return { duplicate: false, similarity: 0, reasons };
  const similarity = titleSimilarity({ title: a.title }, { title: b.title });
  let conflict = numbersDiffer(a.title, b.title);
  // both with a time of day: different times are different events
  if (a.occurredAt.length > 10 && b.occurredAt.length > 10 && a.occurredAt.slice(11, 16) !== b.occurredAt.slice(11, 16)) conflict = true;
  for (const [field, label] of [
    ['topicId', 'gleiches Thema'],
    ['projectId', 'gleiches Projekt'],
  ] as const) {
    const valueA = a[field];
    const valueB = b[field];
    if (!valueA || !valueB) continue;
    if (valueA === valueB) reasons.push(label);
    else conflict = true;
  }
  return { duplicate: !conflict && similarity >= EVENT_MIN_SIMILARITY, similarity, reasons };
}
