export const MAX_DIFF_LINES = 1500;
const normalizeLine = (line: string) => line.replace(/\s+/g, ' ').trim().toLowerCase();
const nonEmptyLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Line based diff (LCS on normalized lines, capped): lines only in A, only in B, and the number of common lines. */
export function diffLines(a: string, b: string): { onlyA: string[]; onlyB: string[]; common: number; capped: boolean } {
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
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < lengthA && j < lengthB) {
    if (keysA[i] === keysB[j]) {
      common += 1;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) onlyA.push(linesA[i++]!);
    else onlyB.push(linesB[j++]!);
  }
  while (i < lengthA) onlyA.push(linesA[i++]!);
  while (j < lengthB) onlyB.push(linesB[j++]!);
  return { onlyA, onlyB, common, capped };
}
