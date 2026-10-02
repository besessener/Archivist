import { normalizeName, tokenize } from '../../util/text';

/** Words that say nothing about the topic X in „leg alle Dokumente zu X in einen Ordner“. */
const SUBJECT_FILLERS = new Set(
  'dokument dokumente dokumenten datei dateien unterlagen ordner ordnern verzeichnis verzeichnisse verzeichnissen ablage archiv archivierten archivierte alle alles leg lege legen gemeinsam zusammen zusammenlegen zusammenfuhren selbe selben gleiche gleichen ein einen einem eine ins kannst konnen bitte mach mache diese dieser dieses die sie davon dazu thema projekt bezug liegen liegt abgelegt pruf prufe prufen konsistent verstreut sortieren umsortieren verschieben verschieb umlagern'.split(
    ' ',
  ),
);

const SUBJECT_STOP = new Set([
  'in',
  'ins',
  'im',
  'zusammen',
  'alle',
  'einen',
  'ein',
  'einem',
  'ordner',
  'verzeichnis',
  'legen',
  'leg',
  'gemeinsam',
  'bitte',
  'und',
  'liegen',
]);

const SUBJECT_ARTICLE = /^(dem|der|den|das|thema|projekt)$/i;

/** The words of a search text that name a topic of its own (not just „die“, „alle“, „Dokumente“). */
export function subjectTokens(text: string): string[] {
  return tokenize(text).filter((t) => !SUBJECT_FILLERS.has(t));
}

/** Rule-based: topic from „X-Dateien“ or „Dokumente zu X“ (without LLM). */
export function subjectFromText(text: string): string | null {
  const dashed = text
    .split(/\s+/)
    .map((word) => word.replace(/[„“"',.;:!?]/g, ''))
    .find((word) => /-(?:dateien|dokumente|unterlagen)$/i.test(word));
  if (dashed) return dashed.replace(/-(?:dateien|dokumente|unterlagen)$/i, '') || null;
  const allWords = text.split(/\s+/).map((word) => word.replace(/[„“"]/g, ''));
  const at = allWords.findIndex((word) => /^(zu|zum|zur|für|über)$/i.test(word));
  if (at < 0) return null;
  const subject = subjectAfter(allWords.slice(at + 1));
  return subject.length ? subject.join(' ') : null;
}

/** Up to four words after „zu“/„über“ …, skipping a leading article and stopping at punctuation or a filler. */
function subjectAfter(candidates: string[]): string[] {
  const subject: string[] = [];
  for (const word of candidates) {
    let clean = word;
    while (/[,.;:!?]$/.test(clean)) clean = clean.slice(0, -1);
    const stop = !clean || SUBJECT_STOP.has(clean.toLowerCase());
    if (stop || SUBJECT_ARTICLE.test(clean)) {
      if (subject.length || stop) break;
      continue;
    }
    subject.push(clean);
    if (subject.length >= 4 || clean !== word) break;
  }
  return subject;
}

/** Known topic or project whose name appears literally in the message (the longest wins). */
export function knownSubjectIn(text: string, names: string[]): string | null {
  const lower = ` ${normalizeName(text)} `;
  return names.filter((n) => normalizeName(n) && lower.includes(` ${normalizeName(n)} `)).sort((a, b) => b.length - a.length)[0] ?? null;
}
