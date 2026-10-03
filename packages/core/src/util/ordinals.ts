const ORDINAL_STEMS = ['erst', 'zweit', 'dritt', 'viert', 'funft'];

/** Zero-based position named by a German ordinal in already normalized text („den zweiten“ → 1); -1 when there is none. */
export function ordinalIndex(normalizedText: string): number {
  return ORDINAL_STEMS.findIndex((stem) => new RegExp(`\\b${stem}(?:e|er|es|en|em)?\\b`).test(normalizedText));
}
