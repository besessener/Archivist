import { normalizeName } from '../util/text';

const SAMPLE_CHARS = 30_000;
const MIN_WORD_LENGTH = 3;

/** The `limit` names that fit a text best (shared words, a name as a whole first); the rest keeps its order, so a short list never hides a matching name. */
export function relevantNames(names: string[], text: string, limit: number): string[] {
  if (names.length <= limit) return names;
  const haystack = ` ${normalizeName(text.slice(0, SAMPLE_CHARS))} `;
  const words = new Set(haystack.split(' '));
  const scored = names.map((name, position) => {
    const normalized = normalizeName(name);
    const shared = normalized.split(' ').filter((word) => word.length >= MIN_WORD_LENGTH && words.has(word)).length;
    const asPhrase = normalized.length >= MIN_WORD_LENGTH && haystack.includes(` ${normalized} `) ? 1 : 0;
    return { name, position, score: shared + asPhrase };
  });
  scored.sort((a, b) => b.score - a.score || a.position - b.position);
  return scored.slice(0, limit).map((entry) => entry.name);
}
