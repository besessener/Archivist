export const MAX_DIFF_LINES = 1500;
const normalizeLine = (line: string) => line.replace(/\s+/g, ' ').trim().toLowerCase();
const nonEmptyLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export interface LineDiff {
  /** Adjacent removed and added lines, paired in order: the same place, a different wording. */
  changed: Array<{ from: string; to: string }>;
  onlyA: string[];
  onlyB: string[];
  common: number;
  capped: boolean;
}

/** Line based diff (LCS on normalized lines, capped): changed line pairs, lines only in A, only in B, and the number of common lines. */
export function diffLines(a: string, b: string): LineDiff {
  const allA = nonEmptyLines(a);
  const allB = nonEmptyLines(b);
  const capped = allA.length > MAX_DIFF_LINES || allB.length > MAX_DIFF_LINES;
  const linesA = allA.slice(0, MAX_DIFF_LINES);
  const linesB = allB.slice(0, MAX_DIFF_LINES);
  const keysA = linesA.map(normalizeLine);
  const keysB = linesB.map(normalizeLine);
  const lengthA = linesA.length;
  const lengthB = linesB.length;
  const width = lengthB + 1;
  // table[i * width + j]: length of the longest common subsequence of A[i..] and B[j..]
  const table = new Uint16Array((lengthA + 1) * width);
  for (let i = lengthA - 1; i >= 0; i -= 1)
    for (let j = lengthB - 1; j >= 0; j -= 1)
      table[i * width + j] = keysA[i] === keysB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const result: LineDiff = { changed: [], onlyA: [], onlyB: [], common: 0, capped };
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k += 1) result.changed.push({ from: removed[k]!, to: added[k]! });
    result.onlyA.push(...removed.slice(paired));
    result.onlyB.push(...added.slice(paired));
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < lengthA && j < lengthB) {
    if (keysA[i] === keysB[j]) {
      flush();
      result.common += 1;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) removed.push(linesA[i++]!);
    else added.push(linesB[j++]!);
  }
  removed.push(...linesA.slice(i));
  added.push(...linesB.slice(j));
  flush();
  return result;
}

/** „Miete 800 € → 850 €“: the words both lines start with are named once, then old → new. */
export function changeLabel({ from, to }: { from: string; to: string }): string {
  const wordsFrom = from.split(' ');
  const wordsTo = to.split(' ');
  let shared = 0;
  while (shared < wordsFrom.length - 1 && shared < wordsTo.length - 1 && wordsFrom[shared]!.toLowerCase() === wordsTo[shared]!.toLowerCase()) shared += 1;
  const head = wordsFrom.slice(0, shared).join(' ');
  return `${head ? `${head} ` : ''}${wordsFrom.slice(shared).join(' ')} → ${wordsTo.slice(shared).join(' ')}`;
}
