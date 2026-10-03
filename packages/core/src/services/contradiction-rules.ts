import { normalizeName } from '../util/text';

const STOP = [
  /nicht\s+(?:mehr\s+)?(?:weiter(?:machen|führen|verfolgen|entwickeln)|fortsetzen|fortführen|einführen|starten|umsetzen)/i,
  /\b(?:pausier\w*|ein(?:ge)?stell\w*|stopp\w*|beend\w*|abbrech\w*|abgebrochen|aussetz\w*|zurückstell\w*|verwerf\w*|absag\w*|aufgeben|aufgegeben)\b/i,
  /vorerst\s+nicht|erstmal\s+nicht|auf\s+eis/i,
  /\bkein(?:e|en)?\s+(?:weiter\w*|fortsetzung)/i,
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

export type Polarity = 'go' | 'stop' | null;

/** Rough lexical polarity of a decision/statement (continue vs. stop). */
export function polarity(text: string): Polarity {
  if (STOP.some((p) => p.test(text))) return 'stop';
  if (GO.some((p) => p.test(text))) return 'go';
  return null;
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
