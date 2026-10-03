const STOPWORDS = new Set(
  'der die das den dem des ein eine einer einem einen eines und oder aber auch nicht mit von zu zum zur im in an auf aus bei nach vor für über unter ist sind war waren wird werden wurde wurden hat haben hatte als wie wir ihr sie es ich du man dass daß so noch nur mehr sehr wenn dann dies diese dieser dieses the a an and or of to in on for with is are was were be been this that it as at by from'.split(
    ' ',
  ),
);

export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Name for comparisons: lower case, without accents, only letters/digits, single spaces. */
export function normalizeName(name: string): string {
  return stripDiacritics(name.toLowerCase().replace(/ß/g, 'ss'))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const tokens = normalizeName(text)
    .split(' ')
    .filter((token) => token.length > 1);
  return opts.keepStopwords ? tokens : tokens.filter((token) => !STOPWORDS.has(token));
}

/** Inflection endings (German and English), longest first; stripped from search terms only. */
const SEARCH_SUFFIXES = ['ungen', 'ung', 'heiten', 'heit', 'keiten', 'keit', 'ing', 'ern', 'en', 'er', 'es', 'em', 'ed', 'e', 'n', 's'];

/** Query-side stemming: FTS matches prefixes without a stemmer, so a cut ending also finds inflections; keeps 4+ characters and numbers. */
export function searchStem(term: string): string {
  if (/\d/.test(term)) return term;
  for (const suffix of SEARCH_SUFFIXES) if (term.endsWith(suffix) && term.length - suffix.length >= 4) return term.slice(0, -suffix.length);
  return term;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min((current[column - 1] ?? 0) + 1, (previous[column] ?? 0) + 1, (previous[column - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Name similarity 0..1 (normalized Levenshtein distance, token overlap). */
export function nameSimilarity(a: string, b: string): number {
  const normalizedA = normalizeName(a);
  const normalizedB = normalizeName(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  const compactA = normalizedA.replace(/ /g, '');
  const compactB = normalizedB.replace(/ /g, '');
  if (compactA === compactB) return 0.98;
  const editSimilarity = 1 - levenshtein(compactA, compactB) / Math.max(compactA.length, compactB.length);
  const tokensA = new Set(normalizedA.split(' '));
  const tokensB = new Set(normalizedB.split(' '));
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  const jaccard = shared / (tokensA.size + tokensB.size - shared);
  return Math.max(editSimilarity, jaccard);
}

/** Splits text at paragraph/sentence boundaries into overlapping chunks. */
export function chunkText(text: string, options: { size?: number; overlap?: number } = {}): string[] {
  const { size = 900, overlap = 120 } = options;
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size * 0.6), end);
      const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (breakAt > 0) end = start + Math.floor(size * 0.6) + breakAt + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function firstSentence(text: string, max = 160): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  const sentence = /^(.+?[.!?])(\s|$)/.exec(collapsed);
  return truncate(sentence?.[1] ?? collapsed, max);
}
