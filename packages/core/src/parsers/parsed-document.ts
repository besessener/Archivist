// The result shape every parser returns, and the text cleanup they share.

export type ParseStatus = 'extracted' | 'partial' | 'unsupported' | 'failed';

export interface ParsedDocument {
  text: string;
  status: ParseStatus;
  error: string | null;
  meta: Record<string, string | number | boolean | null>;
  truncated: boolean;
}

export interface ParseOptions {
  ocrEnabled?: boolean;
  ocrLanguages?: string;
  tessdataDir?: string;
}

export const MAX_TEXT_CHARS = 400_000;

const clip = (text: string): { text: string; truncated: boolean } =>
  text.length > MAX_TEXT_CHARS ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true } : { text, truncated: false };

/** Removes spaces/tabs at line ends without a regex (a pattern like `[ \t]+\n` would be quadratic on long runs of spaces). */
const trimLineEnd = (line: string): string => {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return end === line.length ? line : line.slice(0, end);
};

/** Ligature code points (U+FB00-FB06) split words for the search index; PDF text already arrives expanded (#172). */
const expandLigatures = (text: string) => text.replace(/[\uFB00-\uFB06]/g, (ligature) => ligature.normalize('NFKC'));

const tidy = (text: string) =>
  expandLigatures(text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\u0000', '')
    .split('\n')
    .map(trimLineEnd)
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

/** Clip of the tidied text: the form every parser stores. */
export const cleanText = (text: string) => clip(tidy(text));

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
