import type { Decision } from '@archivist/shared';
import { normalizeName, tokenize } from '../util/text';

/** Stops that already contain their own negation ("vorerst nicht", "keine Fortsetzung"): never flipped. */
const STOP_WITH_NEGATION = [/vorerst\s+nicht|erstmal\s+nicht|auf\s+eis/i, /\bkein(?:e|en)?\s+(?:weiter\w*|fortsetzung)/i];
const STOP = [
  /\b(?:pausier\w*|ein(?:ge)?stell\w*|stopp\w*|beend\w*|abbrech\w*|abgebrochen|aussetz\w*|zurückstell\w*|verwerf\w*|absag\w*|aufgeben|aufgegeben)\b/i,
  /\bstell\w*\b[^.]{0,40}\bein\b/i,
  /\bbrech\w*\b[^.]{0,40}\bab\b/i,
  /\bsetz\w*\b[^.]{0,40}\baus\b/i,
  /\bgeb\w*\b[^.]{0,40}\bauf\b/i,
];
const GO = [
  /\b(?:führ\w*|fuehr\w*|mach\w*|verfolg\w*|entwickl\w*)\b[^.]{0,40}\bweiter\b/i,
  /\b(?:setz\w*)\b[^.]{0,40}\b(?:um|fort)\b/i,
  /\bnehm\w*\b[^.]{0,40}\bwieder\s+auf\b/i,
  /\b(?:weiterführen|weiterfuehren|fortsetzen|fortführen|fortfuehren|weitermachen|weiterverfolgen|weiterentwickeln|wiederaufnehmen|aufnehmen)\b/i,
  /\b(?:starten|einführen|einfuehren|beauftragen|freigeben|freigegeben|genehmigt|umsetzen|umgesetzt|fortgeführt|weitergeführt|fortgesetzt|reaktivier\w*)\b/i,
];
const NEGATION = /\b(?:nicht|kein\w*|niemals|nie)\b/i;
/** Hiring ("einen Entwickler einstellen") and ordering ("eine Bestellung aufgeben") use stop verbs without stopping anything. */
const NOT_A_STOP =
  /\b(?:einen|eine|einem|zwei|drei|vier|fünf|\d+|neue[nrms]?|mitarbeiter\w*|entwickler\w*|personal|fachkraft|fachkräfte|praktikant\w*|bestell\w*|auftrag|aufträge|anzeige|annonce|inserat|gepäck)\b/i;
const CLAUSE_BREAK = /[.;,!?]|\bsondern\b|\baber\b/i;

export type Polarity = 'go' | 'stop' | null;

const flip = (polarity: Exclude<Polarity, null>): Polarity => (polarity === 'go' ? 'stop' : 'go');

function clausePolarity(clause: string): Polarity {
  if (STOP_WITH_NEGATION.some((p) => p.test(clause))) return 'stop';
  const negated = NEGATION.test(clause);
  const stops = !NOT_A_STOP.test(clause) && STOP.some((p) => p.test(clause));
  const polarity: Polarity = stops ? 'stop' : GO.some((p) => p.test(clause)) ? 'go' : null;
  return polarity && negated ? flip(polarity) : polarity;
}

/** Rough lexical polarity of a decision/statement (continue vs. stop): a negation turns a clause around, a "sondern" clause decides. */
export function polarity(text: string): Polarity {
  const clauses = text.split(CLAUSE_BREAK).map(clausePolarity);
  if (/\bsondern\b/i.test(text)) return clauses.findLast((p) => p !== null) ?? null;
  return clauses.includes('stop') ? 'stop' : clauses.includes('go') ? 'go' : null;
}

/** Choice decision „… für X“ / „… auf X“ → X */
export function chosenOption(text: string): string | null {
  const m =
    /(?:entscheiden\s+uns|entschieden|wählen|wählten|setzen|nutzen|verwenden|bleiben)[^.]*?\b(?:für|auf|bei|mit)\s+(?:das\s+|die\s+|den\s+|dem\s+)?([\p{L}0-9][\p{L}0-9._+-]*(?:\s+[A-Z0-9][\p{L}0-9._+-]*)?)/iu.exec(
      text,
    );
  return m?.[1]?.trim() ?? null;
}

export interface LexicalVerdict {
  conflict: boolean;
  reason: string;
  confidence: number;
}

/** Lexical check of two decision texts; null when neither has a recognizable polarity or choice. */
export function compareLexically(a: string, b: string): LexicalVerdict | null {
  const polarityA = polarity(a);
  const polarityB = polarity(b);
  if (polarityA && polarityB && polarityA !== polarityB) {
    return {
      conflict: true,
      reason:
        polarityA === 'go'
          ? 'Eine Entscheidung führt das Thema weiter, die andere stoppt oder pausiert es.'
          : 'Eine Entscheidung stoppt oder pausiert das Thema, die andere führt es weiter.',
      confidence: 0.75,
    };
  }
  const optionA = chosenOption(a);
  const optionB = chosenOption(b);
  if (optionA && optionB && differentOptions(normalizeName(optionA), normalizeName(optionB)))
    return { conflict: true, reason: `Unterschiedliche Auswahl: „${optionA}“ vs. „${optionB}“.`, confidence: 0.55 };
  return polarityA || polarityB || (optionA && optionB) ? { conflict: false, reason: '', confidence: 0 } : null;
}

function differentOptions(a: string, b: string): boolean {
  return a !== b && !a.includes(b) && !b.includes(a);
}

/** Decisions on the same topic or in the same project can contradict or replace each other. */
export function sharesScope(a: Decision, b: Decision): boolean {
  return (a.topicId !== null && a.topicId === b.topicId) || (a.projectId !== null && a.projectId === b.projectId);
}

/** Every pair of decisions that share a topic or a project, each pair once (grouped, so no pairwise scan over all decisions). */
export function relatedPairs(decisions: Decision[]): Array<[Decision, Decision]> {
  const groups = new Map<string, Decision[]>();
  for (const decision of decisions)
    for (const key of [decision.topicId && `topic:${decision.topicId}`, decision.projectId && `project:${decision.projectId}`])
      if (key) groups.set(key, [...(groups.get(key) ?? []), decision]);
  const pairs = new Map<string, [Decision, Decision]>();
  for (const group of groups.values())
    for (const [index, first] of group.entries())
      for (const second of group.slice(index + 1)) pairs.set([first.id, second.id].sort().join('|'), [first, second]);
  return [...pairs.values()];
}

const MIN_SHARED_WORD_LENGTH = 4;

/** Whether two decision texts talk about the same thing: they share at least one content word. */
export function sharesContent(a: string, b: string): boolean {
  const wordsOfB = new Set(tokenize(b).filter((word) => word.length >= MIN_SHARED_WORD_LENGTH));
  return tokenize(a).some((word) => word.length >= MIN_SHARED_WORD_LENGTH && wordsOfB.has(word));
}
