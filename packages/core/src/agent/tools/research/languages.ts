export type DocumentLanguage = 'de' | 'en' | 'fr' | 'es' | 'it';

export const LANGUAGE_NAME: Record<DocumentLanguage, string> = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch' };

// only words that are rare in the other four languages ("in", "an", "die", "en", "de", "la", "es", "un" are left out)
export const STOPWORDS: Record<DocumentLanguage, string[]> = {
  de: 'der das und ist nicht eine mit für auf von den dem auch sich wir sie ich werden wurde bitte vom zum zur sind haben hat bei nach über oder wenn aber noch wie wird sehr'.split(
    ' ',
  ),
  en: 'the and of that with this was are have for from your you will our please not which been their would they there what'.split(' '),
  fr: 'les des est une et du que pour dans qui pas sur avec vous nous votre aux cette sont mais être je elle très ont comme'.split(' '),
  es: 'el los las del una por con para como pero este esta está muy sobre también usted su sus hola gracias nuestro todos hemos'.split(' '),
  it: 'il gli della delle dei degli che per sono non come più questo questa nel nella alla anche perché grazie gentile siamo abbiamo'.split(' '),
};

const LANGUAGE_OF_WORD = new Map(Object.entries(STOPWORDS).flatMap(([language, words]) => words.map((word) => [word, language as DocumentLanguage] as const)));

const SAMPLE_CHARS = 4000;
const MIN_HITS = 4;
const MIN_LEAD = 2;

export interface LanguageGuess {
  language: DocumentLanguage;
  /** Share of the counted stopwords that belong to the language, 0..1. */
  share: number;
}

/** Language of a text by stopword counts (first 4000 characters); null when too short or unclear (the leader needs twice the hits of the runner-up). */
export function detectLanguage(text: string): LanguageGuess | null {
  const hits: Record<DocumentLanguage, number> = { de: 0, en: 0, fr: 0, es: 0, it: 0 };
  for (const word of text
    .slice(0, SAMPLE_CHARS)
    .toLowerCase()
    .match(/\p{L}+/gu) ?? []) {
    const language = LANGUAGE_OF_WORD.get(word);
    if (language) hits[language] += 1;
  }
  const [best, runnerUp] = (Object.entries(hits) as Array<[DocumentLanguage, number]>).toSorted((a, b) => b[1] - a[1]);
  if (best![1] < MIN_HITS || best![1] < runnerUp![1] * MIN_LEAD) return null;
  const total = Object.values(hits).reduce((sum, count) => sum + count, 0);
  return { language: best![0], share: best![1] / total };
}
