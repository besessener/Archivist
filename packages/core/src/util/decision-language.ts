/** Wording that makes a decision sentence a question, a negation or still open rather than a decision (#176; German and English). */
const UNDECIDED =
  /\b(noch nicht|nicht (?:entschieden|beschlossen)|keine (?:entscheidung|beschluss)|unentschieden|ungeklärt|vertagt|offen|ob|muss noch|soll noch|steht noch aus|not yet|not (?:yet )?(?:decided|agreed)|no (?:decision|agreement)|undecided|to be decided|yet to be (?:decided|agreed)|postponed|tabled|still open|whether|need(?:s)? to (?:decide|agree))\b/i;

export const isUndecidedWording = (sentence: string): boolean => UNDECIDED.test(sentence);

/** A sentence that states a decision, in German or English („beschlossen“, „Beschluss:“, „we decided“, „Decision:“); {@link isUndecidedWording} still applies. */
export const mentionsDecision = (sentence: string): boolean =>
  /(?:wir\s+haben\s+)?(?:beschlossen|entschieden)|beschluss:|entscheidung:|\b(?:we|i|they)\s+(?:have\s+)?(?:decided|agreed|resolved)\b|\bit\s+(?:was|has\s+been)\s+(?:decided|agreed)\b|\b(?:decision|resolution|agreed|approved)\s*:/i.test(
    sentence,
  );

/** Explicit first-person statement – the only wording trusted without asking back. */
export const isExplicitDecision = (sentence: string): boolean =>
  !isUndecidedWording(sentence) &&
  /\b(?:wir|ich)\s+haben\s+[^?!]{0,60}?(?:entschieden|beschlossen)|^beschluss:|^entscheidung:|\b(?:we|i)\s+(?:have\s+)?(?:decided|agreed)\b|^(?:decision|resolution):/i.test(sentence.trim());
