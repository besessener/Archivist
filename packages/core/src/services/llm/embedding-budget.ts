const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Cut to `maxChars` without leaving half of a surrogate pair at the end. */
function cut(text: string, maxChars: number): string {
  const end = maxChars > 0 && isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}

/**
 * The texts of one document (or record) as far as a remote embedding request may carry them: whole texts from the front while their total fits `maxChars`,
 * the rest is left out. Only a first text that alone exceeds the limit is cut, so every entry still gets a vector.
 */
export function withinCharBudget(texts: readonly string[], maxChars: number): string[] {
  const sent: string[] = [];
  let used = 0;
  for (const text of texts) {
    if (used + text.length > maxChars) {
      if (sent.length === 0 && maxChars > 0) sent.push(cut(text, maxChars));
      break;
    }
    sent.push(text);
    used += text.length;
  }
  return sent;
}
