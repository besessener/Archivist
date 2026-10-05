export type TableBlock = { kind: 'table'; header: string[]; rows: string[][] };

/** Splits `| a | b |` into trimmed cells; `\|` stays part of a cell. */
function splitCells(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.replaceAll('\\|', '|').trim());
}

function isRow(line: string | undefined): line is string {
  return line !== undefined && line.includes('|') && line.trim() !== '';
}

function isSeparator(line: string | undefined): boolean {
  if (!isRow(line)) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** A table starting at `start` (header row, separator row, body rows), or undefined if the lines there are no table. */
export function readTable({ lines, start }: { lines: string[]; start: number }): { block: TableBlock; next: number } | undefined {
  const headerLine = lines[start];
  if (!isRow(headerLine) || !isSeparator(lines[start + 1])) return undefined;
  const header = splitCells(headerLine);
  const rows: string[][] = [];
  let next = start + 2;
  for (let line = lines[next]; isRow(line); line = lines[++next]) rows.push(splitCells(line));
  return { block: { kind: 'table', header, rows }, next };
}
