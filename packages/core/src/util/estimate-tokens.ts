const CHARS_PER_TOKEN = 4;

/** Rough token count of a text (or of a number of characters): one token per four characters, rounded up. */
export function estimateTokens(textOrChars: string | number): number {
  const chars = typeof textOrChars === 'string' ? textOrChars.length : textOrChars;
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}
