import { OCR_LANGUAGE_CHOICES } from '@archivist/shared';

const OFFERED: ReadonlySet<string> = new Set(OCR_LANGUAGE_CHOICES.map((choice) => choice.code));

/** The configured `+`-list as codes, e.g. `deu+chi_sim` → `['deu', 'chi_sim']`. */
export function ocrLanguageCodes(languages: string): string[] {
  return languages.split('+').filter((code) => code.length > 0);
}

/** Configured codes the settings do not offer (e.g. `chi_sim` from the configuration file). */
export function otherOcrLanguages(languages: string): string[] {
  return ocrLanguageCodes(languages).filter((code) => !OFFERED.has(code));
}

/** The list after switching one offered language on or off: offered ones in their order, then every other configured code unchanged. */
export function toggleOcrLanguage(languages: string, change: { code: string; checked: boolean }): string {
  const selected = new Set(ocrLanguageCodes(languages));
  if (change.checked) selected.add(change.code);
  else selected.delete(change.code);
  const offered = OCR_LANGUAGE_CHOICES.map((choice) => choice.code).filter((code) => selected.has(code));
  return [...offered, ...otherOcrLanguages(languages)].join('+');
}
