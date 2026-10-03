import type { DocumentClassification } from '@archivist/shared';
import { redactSecrets, type RedactionOptions } from '../util/redact';
import { normalizeName } from '../util/text';

/** Upper bound of LLM requests for one document (cost and time); the rest of a longer text is reported as not read. */
export const MAX_LLM_PARTS = 6;

/** Smallest part worth a request, whatever the input limit and prompt header leave. */
const MIN_PART_CHARS = 500;

/** Share of the input limit a part may fill: redaction and the cut note must never push a request over the limit. */
const PART_FILL = 0.95;

/** Characters of text one request can carry: the input limit less the prompt around the text. */
export function partSize(limits: { maxInputChars: number; promptChars: number }): number {
  return Math.max(MIN_PART_CHARS, Math.floor((limits.maxInputChars - limits.promptChars) * PART_FILL));
}

/** Characters on each side of a cut that are checked for an identifier the cut would split. */
const CUT_WINDOW = 2_000;

/** Whether cutting `text` at `position` leaves every masked spot (secret, IBAN, card number …) whole on one side. */
export function cutKeepsMasking(text: string, position: number, masking: RedactionOptions): boolean {
  const left = text.slice(Math.max(0, position - CUT_WINDOW), position);
  const right = text.slice(position, position + CUT_WINDOW);
  return redactSecrets(left + right, masking).count === redactSecrets(left, masking).count + redactSecrets(right, masking).count;
}

/** The text in consecutive parts of at most `size` characters, cut at a line break where one is near and never inside `isSafeCut`'s refusal; at most `MAX_LLM_PARTS` parts. */
export function splitIntoParts(text: string, size: number, isSafeCut: (text: string, position: number) => boolean = () => true): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length && parts.length < MAX_LLM_PARTS) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const lineBreak = text.lastIndexOf('\n', end);
      if (lineBreak > start + size / 2) end = lineBreak + 1;
      while (end > start + size / 2 && !isSafeCut(text, end)) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** The first item per key. */
const distinctBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && seen.add(key(item)));
};

/** The classification of the first part with the decisions, open items, people, tags and dates of all parts. */
export function mergeParts(results: [DocumentClassification, ...DocumentClassification[]]): DocumentClassification {
  const [first] = results;
  return {
    ...first,
    persons: distinctBy(
      results.flatMap((r) => r.persons),
      normalizeName,
    ),
    tags: [...new Set(results.flatMap((r) => r.tags))],
    dates: distinctBy(
      results.flatMap((r) => r.dates),
      (d) => d.date,
    ),
    decisions: distinctBy(
      results.flatMap((r) => r.decisions),
      (d) => normalizeName(d.decisionText),
    ),
    openItems: distinctBy(
      results.flatMap((r) => r.openItems),
      (o) => normalizeName(o.title),
    ),
  };
}
