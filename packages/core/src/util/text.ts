const STOPWORDS = new Set(
  'der die das den dem des ein eine einer einem einen eines und oder aber auch nicht mit von zu zum zur im in an auf aus bei nach vor für über unter ist sind war waren wird werden wurde wurden hat haben hatte als wie wir ihr sie es ich du man dass daß so noch nur mehr sehr wenn dann dies diese dieser dieses the a an and or of to in on for with is are was were be been this that it as at by from'.split(
    ' ',
  ),
);

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Name for comparisons: lower case, without accents, only letters/digits, single spaces. */
export function normalizeName(s: string): string {
  return stripDiacritics(s.toLowerCase().replace(/ß/g, 'ss'))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const tokens = normalizeName(text)
    .split(' ')
    .filter((t) => t.length > 1);
  return opts.keepStopwords ? tokens : tokens.filter((t) => !STOPWORDS.has(t));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Name similarity 0..1 (normalized Levenshtein distance, token overlap). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const compactA = na.replace(/ /g, '');
  const compactB = nb.replace(/ /g, '');
  if (compactA === compactB) return 0.98;
  const lev = 1 - levenshtein(compactA, compactB) / Math.max(compactA.length, compactB.length);
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jac = inter / (ta.size + tb.size - inter);
  return Math.max(lev, jac);
}

/** Splits text at paragraph/sentence boundaries into overlapping chunks. */
export function chunkText(text: string, size = 900, overlap = 120): string[] {
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
  const t = text.trim().replace(/\s+/g, ' ');
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return truncate(m?.[1] ?? t, max);
}
