import { normalizeName } from '../../util/text';

/** How two names are related, from most to least certain. */
export type DuplicateMatch = 'alias' | 'spelling' | 'plural' | 'typo' | 'prefix';

/** German/English plural endings appended to the singular (umlauts are compared without diacritics). */
const PLURAL_SUFFIXES = new Set(['e', 'n', 'en', 'er', 's', 'es', 'nen']);

interface NameForms {
  /** Normalized name (see `normalizeName`). */
  plain: string;
  tokens: string[];
  /** Name without separators: once with stripped diacritics (ü → u), once transliterated (ü → ue). */
  compacts: string[];
  digits: string;
}

/** Forms are computed once per name: a run compares every pair of names of a type. */
const formsCache = new Map<string, NameForms>();

function forms(name: string): NameForms {
  const cached = formsCache.get(name);
  if (cached) return cached;
  if (formsCache.size > 10_000) formsCache.clear();
  const computed = computeForms(name);
  formsCache.set(name, computed);
  return computed;
}

function computeForms(name: string): NameForms {
  const lower = name.toLowerCase();
  const plain = normalizeName(lower);
  const translit = normalizeName(lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'));
  return {
    plain,
    tokens: plain.split(' ').filter(Boolean),
    compacts: [...new Set([plain.replace(/ /g, ''), translit.replace(/ /g, '')])],
    digits: (plain.match(/\d+/g) ?? []).join(' '),
  };
}

/** Optimal string alignment distance (Levenshtein plus swapped neighbours), capped early by length difference. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const pairs = <T>(xs: T[], ys: T[]): Array<[T, T]> => xs.flatMap((x) => ys.map((y): [T, T] => [x, y]));

function isPlural(x: string, y: string): boolean {
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length < 3) return false;
  if (l.startsWith(s) && PLURAL_SUFFIXES.has(l.slice(s.length))) return true;
  return s.endsWith('y') && l === `${s.slice(0, -1)}ies`;
}

/** Edits tolerated as a typo: none for short words, one from 6 letters, two from 11. */
function withinTypoLimit(x: string, y: string): boolean {
  const longest = Math.max(x.length, y.length);
  const allowed = longest >= 11 ? 2 : longest >= 6 ? 1 : 0;
  return allowed > 0 && Math.abs(x.length - y.length) <= allowed && editDistance(x, y) <= allowed;
}

/** Same word count: compared word by word, so „Gruppe A“ / „Gruppe B“ is no typo; otherwise without separators. */
function isTypo(a: NameForms, b: NameForms): boolean {
  if (a.tokens.length > 1 && a.tokens.length === b.tokens.length) {
    const diff = a.tokens.map((t, i) => [t, b.tokens[i]!] as const).filter(([x, y]) => x !== y);
    return diff.length > 0 && diff.every(([x, y]) => withinTypoLimit(x, y));
  }
  return pairs(a.compacts, b.compacts).some(([x, y]) => withinTypoLimit(x, y));
}

/** „Urlaub“ ↔ „Urlaub 2026“: the shorter name is the start of the longer one (one or two more words). */
function isPrefix(a: NameForms, b: NameForms): boolean {
  const [s, l] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
  const extra = l.tokens.length - s.tokens.length;
  if (extra < 1 || extra > 2 || s.tokens.join('').length < 4) return false;
  return s.tokens.every((t, i) => l.tokens[i] === t);
}

/** Classifies two names of one type as possible duplicates, or null; differing numbers only ever make a prefix case. */
export function classifyNames(a: { name: string; aliases?: string[] }, b: { name: string; aliases?: string[] }): DuplicateMatch | null {
  const formsA = forms(a.name);
  const formsB = forms(b.name);
  const [plainA, plainB] = [formsA.plain, formsB.plain];
  if (!plainA || !plainB) return null;
  if ((b.aliases ?? []).some((x) => normalizeName(x) === plainA) || (a.aliases ?? []).some((x) => normalizeName(x) === plainB)) return 'alias';
  if (formsA.digits === formsB.digits) {
    if (plainA === plainB || pairs(formsA.compacts, formsB.compacts).some(([x, y]) => x === y)) return 'spelling';
    if (formsA.tokens.length > 1 && [...formsA.tokens].sort().join(' ') === [...formsB.tokens].sort().join(' ')) return 'spelling';
    if (pairs(formsA.compacts, formsB.compacts).some(([x, y]) => isPlural(x, y))) return 'plural';
    if (isTypo(formsA, formsB)) return 'typo';
  }
  return isPrefix(formsA, formsB) ? 'prefix' : null;
}
