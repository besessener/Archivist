/** Wording that makes an „entschieden/beschlossen“ sentence a question, a negation or still open rather than a decision (#176). */
const UNDECIDED =
  /\b(noch nicht|nicht (?:entschieden|beschlossen)|keine (?:entscheidung|beschluss)|unentschieden|ungeklärt|vertagt|offen|ob|muss noch|soll noch|steht noch aus)\b/i;

export const isUndecidedWording = (sentence: string): boolean => UNDECIDED.test(sentence);

/** Explicit first-person statement – the only wording trusted without asking back. */
export const isExplicitDecision = (sentence: string): boolean =>
  !isUndecidedWording(sentence) &&
  /\b(?:wir|ich)\s+haben\s+[^?!]{0,60}?(?:entschieden|beschlossen)|^beschluss:|^entscheidung:/i.test(sentence.trim());
