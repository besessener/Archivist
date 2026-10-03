import type { OpenItem } from '@archivist/shared';
import { levenshtein, tokenize } from '../util/text';

/** Detects typical "open item" phrasings locally (without LLM). */
const OPEN_PATTERNS = [
  /muss\s+noch\s+(?:geklärt|geprüft|entschieden|abgestimmt)\s+werden/i,
  /noch\s+(?:zu\s+)?(?:klären|prüfen|entscheiden|abstimmen)/i,
  /offen\s+ist\b|ist\s+(?:noch\s+)?offen\b|offener?\s+punkt/i,
  /später\s+entscheiden/i,
  /\bTBD\b|\bTBC\b|\bpending\b/i,
  /ungeklärt|ungeklaert/i,
  /rückmeldung\s+(?:steht\s+)?(?:noch\s+)?aus(?:stehend)?|ausstehende\s+rückmeldung/i,
  /entscheidung\s+(?:steht\s+)?(?:noch\s+)?aus(?:stehend)?|ausstehende\s+entscheidung/i,
  /follow[- ]?up\s+(?:ist\s+)?erforderlich/i,
  /\bto\s+be\s+(?:clarified|checked|decided|confirmed|agreed)\b/i,
  /\bopen\s+(?:item|point|question)\b|\b(?:action\s+item|follow[- ]?up)\s*:/i,
  /\bnot\s+yet\s+(?:clarified|decided|resolved)\b/i,
];

export function detectOpenItemSentences(text: string, max = 8): string[] {
  const sentences = text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 400);
  return sentences.filter((s) => OPEN_PATTERNS.some((p) => p.test(s))).slice(0, max);
}

/** Filler words in hints at open items („erledigt“, „schließ den Punkt“) that say nothing about the item. */
const HINT_FILLERS = new Set(
  'erledigt erledige erledigen erledigung schliess schliesse schliessen geschlossen punkt punkte offen offene offenen offener aufgabe aufgaben todo todos bitte mach mache machen kann koennen konnen soll sollte done fertig abgeschlossen abhaken hak hake erinnere erinner erinnern erinnerung mich mir daran dran verschieb verschiebe verschieben aendern andern andere setze setz wieder nochmal mal ok okay ja jetzt heute morgen gerade schon endlich raus damit thema zum zur'.split(
    ' ',
  ),
);

/** Time expressions say nothing about which item is meant („erinnere mich in sieben Tagen daran“). */
const TIME_WORDS = new Set(
  'tag tage tagen woche wochen monat monaten monate jahr jahren stunde stunden minute minuten montag dienstag mittwoch donnerstag freitag samstag sonntag januar februar marz april mai juni juli august september oktober november dezember naechsten nachsten nachste nachster kommenden kommende uebermorgen ubermorgen am um vom abend abends frueh fruh mittag vormittag nachmittag eins zwei drei vier fuenf funf sechs sieben acht neun zehn elf zwoelf zwolf einer einem einen ein eine bis ab'.split(
    ' ',
  ),
);

/** Words of a hint that actually say something about the item meant (without filler, stop and time words). */
export function hintTokens(hint: string): string[] {
  return [...new Set(tokenize(hint).filter((t) => !HINT_FILLERS.has(t) && !TIME_WORDS.has(t) && !/^\d+$/.test(t)))];
}

export type HintMatch = { status: 'match'; item: OpenItem } | { status: 'ambiguous'; items: OpenItem[] } | { status: 'none' };

const MATCH_THRESHOLD = 0.5;
const AMBIGUITY_MARGIN = 0.15;

/** Abbreviations and word beginnings: „Präsi“ → „Präsentation“, „Steuer“ in „Steuererklärung“. */
const isWordStart = (wanted: string, token: string) => (wanted.length >= 3 && token.startsWith(wanted)) || (token.length >= 4 && wanted.startsWith(token));

function isNearMiss(wanted: string, token: string): boolean {
  if (wanted.length < 5 || token.length < 5) return false;
  return 1 - levenshtein(wanted, token) / Math.max(wanted.length, token.length) >= 0.8;
}

function tokenScore(wanted: string, tokens: string[]): number {
  let best = 0;
  for (const token of tokens) {
    if (token === wanted) return 1;
    if (isWordStart(wanted, token)) best = Math.max(best, 0.8);
    else if (isNearMiss(wanted, token)) best = Math.max(best, 0.6);
  }
  return best;
}

/** Share (0..1) of the hint tokens ({@link hintTokens}) found in an item: title words fully, description words 0.7. */
export function scoreHintTokens(wanted: string[], item: { title: string; description?: string | null }): number {
  if (!wanted.length) return 0;
  const title = tokenize(item.title, { keepStopwords: true });
  const description = tokenize(item.description ?? '', { keepStopwords: true });
  return wanted.reduce((sum, token) => sum + Math.max(tokenScore(token, title), 0.7 * tokenScore(token, description)), 0) / wanted.length;
}

/** Ranks open items against a hint word by word, fuzzy only last; close best hits are ambiguous, weak ones no hit. */
export function matchOpenItems<T extends { title: string; description?: string | null }>({
  hint,
  items,
  ...opts
}: {
  hint: string;
  items: T[];
  threshold?: number;
}): { status: 'match'; item: T } | { status: 'ambiguous'; items: T[] } | { status: 'none' } {
  const wanted = hintTokens(hint);
  if (!wanted.length) return { status: 'none' };
  const scored = items
    .map((item) => ({ item, score: scoreHintTokens(wanted, item) }))
    .filter((x) => x.score >= (opts.threshold ?? MATCH_THRESHOLD))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: 'none' };
  const close = scored.filter((x) => x.score >= scored[0]!.score - AMBIGUITY_MARGIN);
  return close.length === 1 ? { status: 'match', item: close[0]!.item } : { status: 'ambiguous', items: close.slice(0, 4).map((x) => x.item) };
}
