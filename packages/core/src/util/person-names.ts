import { nameSimilarity, stripDiacritics } from './text';

/**
 * Pure helpers for person names: parsing mentions ("Dr. Monika Lor-Zade (Chefin)", "Lor-Zade, Monika"), a comparison
 * key that defines "the same person" and a classification of unclear pairs (first name only, initial, …).
 * Shared by the central person resolution, the automatic duplicate merge and the questions on unclear persons.
 */

export interface ParsedPersonName {
  /** Trimmed input with collapsed whitespace. */
  raw: string;
  /** Display name without roles and titles in natural order ("Monika Lor-Zade"); empty if nothing name-like is left. */
  cleanName: string;
  /** Roles found in the input ("(chefin)", " – Führungskraft", ", Teamleiterin"), first letter capitalized. */
  roles: string[];
  /** Titles and salutations removed from the name ("Dr.", "Prof.", "Herr", "Frau"). */
  titles: string[];
  /**
   * Key for "is the same person": case, hyphen vs. space, umlaut spellings (ü/ue, ß/ss), roles, titles and the order
   * "Nachname, Vorname" are ignored. Equal keys = unambiguous duplicate.
   */
  comparisonKey: string;
}

/** Relation between two person names; `same` = equal comparison keys, everything else is unclear and must be asked. */
export type PersonNameRelation = 'same' | 'first_name_only' | 'last_name_only' | 'initial' | 'middle_name' | 'similar_spelling';

/** Minimum {@link nameSimilarity} of two comparison keys to count as a similar spelling ("Lorzadeh" ↔ "Lor-Zade"). */
const SIMILAR_SPELLING = 0.85;

const fold = (s: string): string =>
  stripDiacritics(s.normalize('NFC').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'));

/** Comparison form of any name or word: lower case, umlauts as ae/oe/ue, ß as ss, only letters/digits, single spaces. */
export function personNameKey(s: string): string {
  return fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words that refer to the speaker; never a person name, but the own identity may resolve them (chat only). */
const SELF_REFERENCES = new Set(['ich', 'mir', 'mich', 'mein', 'meine', 'meiner', 'meinem', 'meinen', 'meins', 'selbst', 'ich selbst', 'me', 'myself']);

/** Pronouns and answer words that are never created as persons. Compared by {@link personNameKey}. */
const NOT_A_PERSON = new Set([
  ...SELF_REFERENCES,
  // pronouns and indefinite words
  'du', 'dir', 'dich', 'dein', 'deine', 'er', 'ihn', 'ihm', 'sie', 'ihr', 'ihnen', 'es', 'wir', 'uns', 'unser', 'unsere', 'euch', 'euer',
  'man', 'jemand', 'niemand', 'keiner', 'keine', 'kein', 'keins', 'alle', 'jeder', 'jede', 'wer', 'andere', 'sonst wer',
  'you', 'i', 'we', 'they', 'someone', 'somebody', 'anyone', 'nobody', 'everyone', 'none',
  // salutations without a name and answer words
  'herr', 'frau', 'ja', 'nein', 'jein', 'ok', 'okay', 'jo', 'noe', 'doch', 'genau', 'stimmt', 'richtig', 'falsch', 'vielleicht', 'egal', 'danke',
  'unbekannt', 'unklar', 'offen', 'noch offen', 'nicht bekannt', 'unbestimmt', 'keine ahnung', 'weiss nicht', 'weiss ich nicht',
  'spaeter', 'abbrechen', 'na', 'n a', 'null', 'tbd', 'todo', 'yes', 'no', 'unknown',
]); // prettier-ignore

/** Exact role words (folded) that may also appear without brackets ("Monika Chefin", ", Teamleiterin"). */
const ROLE_WORDS = new Set(
  `chef chefin leiter leiterin leitung teamleiter teamleiterin teamleitung abteilungsleiter abteilungsleiterin bereichsleiter bereichsleiterin
  projektleiter projektleiterin projektleitung gruppenleiter gruppenleiterin geschaeftsfuehrer geschaeftsfuehrerin geschaeftsfuehrung fuehrungskraft
  vorgesetzter vorgesetzte manager managerin projektmanager projektmanagerin ceo cto cfo coo cio vorstand vorstaendin kollege kollegin kunde kundin
  assistent assistentin assistenz sekretaer sekretaerin praktikant praktikantin werkstudent werkstudentin azubi berater beraterin entwickler
  entwicklerin architekt architektin admin administrator administratorin sachbearbeiter sachbearbeiterin referent referentin mitarbeiter
  mitarbeiterin ansprechpartner ansprechpartnerin teamlead inhaber inhaberin direktor direktorin praesident praesidentin vermieter vermieterin
  steuerberater steuerberaterin anwalt anwaeltin rechtsanwalt rechtsanwaeltin arzt aerztin hausarzt hausaerztin`.split(/\s+/),
);
/** Endings of compound role words ("Bereichsleiterin", "IT-Leiter") – only used to decide whether a comma part is a role. */
const ROLE_ENDINGS = ['leiter', 'leiterin', 'leitung', 'chef', 'chefin', 'manager', 'managerin', 'fuehrer', 'fuehrerin', 'fuehrungskraft', 'berater', 'beraterin', 'entwickler', 'entwicklerin', 'architekt', 'architektin', 'owner', 'lead', 'assistent', 'assistentin', 'referent', 'referentin', 'direktor', 'direktorin', 'mitarbeiter', 'mitarbeiterin']; // prettier-ignore

/** Salutations and academic titles; the abbreviations (hr., dipl., …) only count with a trailing period. */
const TITLE_WORDS = new Set(['herr', 'frau', 'dr', 'prof', 'professor', 'professorin', 'mr', 'mrs', 'ms']);
const TITLE_ABBREVIATIONS = new Set(['hr', 'fr', 'dipl', 'ing', 'mag', 'med', 'rer', 'nat', 'phil', 'jur', 'h c']);

function isTitle(token: string): boolean {
  if (/^(dr|dipl|prof)\.-?\p{L}+\.?$/iu.test(token)) return true; // Dr.-Ing., Dipl.-Kfm.
  const word = personNameKey(token);
  if (TITLE_WORDS.has(word)) return true;
  return token.endsWith('.') && TITLE_ABBREVIATIONS.has(word);
}

const isRoleWord = (token: string): boolean => ROLE_WORDS.has(personNameKey(token).replace(/ /g, ''));

/** True for text containing role words ("Chefin", "IT-Leiter", "Bereichsleiterin", "CEO"). */
function containsRoleWord(text: string): boolean {
  return text.split(' ').some((t) => {
    if (/^\p{Lu}{2,5}$/u.test(t)) return true; // acronyms: CEO, IT, HR
    const k = personNameKey(t).replace(/ /g, '');
    return ROLE_WORDS.has(k) || ROLE_ENDINGS.some((e) => k.length > e.length + 1 && k.endsWith(e));
  });
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Removes the given characters from both ends (a loop instead of a backtracking regex). */
function trimChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start += 1;
  while (end > start && chars.includes(s[end - 1]!)) end -= 1;
  return s.slice(start, end);
}
const trimPunctuation = (s: string): string => trimChars(s, ' \t,;:–—-');
const capitalize = (s: string): string => (s ? s[0]!.toLocaleUpperCase('de-DE') + s.slice(1) : s);

/** Removes leading titles; at least one name token is always kept. */
function stripTitles(part: string, titles: string[]): string {
  const tokens = part.split(' ').filter(Boolean);
  while (tokens.length > 1 && isTitle(tokens[0]!)) titles.push(tokens.shift()!);
  return tokens.join(' ');
}

function splitRoles(text: string): string[] {
  return text
    .split(/[,;/|&]/)
    .flatMap((r) => collapse(r).split(' und '))
    .map((r) => capitalize(trimPunctuation(collapse(r))))
    .filter((r) => personNameKey(r).length > 0);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = personNameKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Parses a person mention. Roles are taken from brackets, after a spaced dash and after a comma; a comma is read as
 * "Nachname, Vorname" instead when the part before it is a single word and the part after it looks like first names
 * (capitalized, no role words): "Lor-Zade, Monika" → "Monika Lor-Zade", but "Monika Lor-Zade, Chefin" → role.
 */
export function parsePersonName(input: string): ParsedPersonName {
  const raw = collapse(input);
  const roles: string[] = [];
  const titles: string[] = [];
  let s = trimChars(raw, `"'„“”‚‘’»« `);

  // roles in brackets
  s = s.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (_m, inner: string) => {
    roles.push(...splitRoles(inner));
    return ' ';
  });
  s = collapse(s);

  // roles after a spaced dash ("Monika Lor-Zade – Führungskraft"); a hyphen inside a name has no spaces
  const dash = /\s[–—-]\s/.exec(s);
  if (dash) {
    roles.push(...splitRoles(s.slice(dash.index + dash[0].length)));
    s = s.slice(0, dash.index);
  }

  // comma: "Nachname, Vorname" or "Name, Rolle"
  const parts = s
    .split(/[,;]/)
    .map((p) => trimPunctuation(p))
    .filter(Boolean);
  let name = parts[0] ?? '';
  if (parts.length > 1) {
    const last = stripTitles(parts[0]!, titles);
    const firstTitles: string[] = [];
    const first = stripTitles(parts[1]!, firstTitles);
    const firstTokens = first.split(' ');
    // a lower-case part after a capitalized name is a role ("Monika, chefin"); all lower case is just sloppy typing
    const lowerCaseRole = /^\p{Ll}/u.test(first) && !/^\p{Ll}/u.test(last);
    const reorder = last.split(' ').length === 1 && firstTokens.length <= 3 && !containsRoleWord(first) && !lowerCaseRole;
    if (reorder) {
      titles.push(...firstTitles);
      name = `${first} ${last}`;
      for (const p of parts.slice(2)) roles.push(...splitRoles(p));
    } else {
      name = last;
      for (const p of parts.slice(1)) roles.push(...splitRoles(p));
    }
  }

  // titles in front of the name, role words around it ("Chefin Monika", "Monika Lor-Zade Teamleiterin")
  const tokens = stripTitles(collapse(name), titles).split(' ').filter(Boolean);
  while (tokens.length > 1 && isRoleWord(tokens[tokens.length - 1]!)) roles.unshift(capitalize(tokens.pop()!));
  while (tokens.length > 1 && isRoleWord(tokens[0]!)) roles.unshift(capitalize(tokens.shift()!));
  const cleanName = trimPunctuation(tokens.join(' '));
  return { raw, cleanName, roles: dedupe(roles), titles, comparisonKey: personNameKey(cleanName) };
}

/** True for pronouns, answer words ("ja", "nein", "unbekannt") and text without letters: never a person. */
export function isNotAPersonName(input: string): boolean {
  const parsed = parsePersonName(input);
  const key = parsed.comparisonKey;
  if (!/\p{L}/u.test(key) || key.replace(/ /g, '').length < 2) return true;
  return NOT_A_PERSON.has(key) || NOT_A_PERSON.has(personNameKey(parsed.raw));
}

/** True for words meaning the speaker ("ich", "mir", "mich", "mein …"); see the self resolver of the person service. */
export function isSelfReference(input: string): boolean {
  return SELF_REFERENCES.has(personNameKey(input));
}

interface NameParts {
  key: string;
  /** Folded name parts; hyphenated names stay one part ("lorzade"). */
  parts: string[];
  /** Per part: the initial letter if the part is an initial ("M."), else null. */
  initials: Array<string | null>;
}

function nameParts(name: string): NameParts {
  const parsed = parsePersonName(name);
  const tokens = parsed.cleanName.split(' ').filter((t) => personNameKey(t));
  return {
    key: parsed.comparisonKey,
    parts: tokens.map((t) => personNameKey(t).replace(/ /g, '')),
    initials: tokens.map((t) => (/^\p{L}\.?$/u.test(t) ? personNameKey(t) : null)),
  };
}

/** `short` abbreviates `long` with at least one initial and otherwise equal parts, in order ("M. Lor-Zade"). */
function isInitialForm(short: NameParts, long: NameParts): boolean {
  if (!short.initials.some(Boolean) || short.parts.length < 2 || short.parts.length > long.parts.length) return false;
  if (short.parts[short.parts.length - 1] !== long.parts[long.parts.length - 1]) return false;
  let j = 0;
  for (let i = 0; i < short.parts.length - 1; i += 1) {
    const initial = short.initials[i];
    while (j < long.parts.length - 1 && !(initial ? long.parts[j]!.startsWith(initial) : long.parts[j] === short.parts[i])) j += 1;
    if (j >= long.parts.length - 1) return false;
    j += 1;
  }
  return true;
}

/**
 * Classifies two person names: `same` for equal comparison keys (unambiguous duplicate), otherwise the reason why
 * they might be the same person (first/last name only, initial, middle name, similar spelling) or `null`.
 */
export function comparePersonNames(a: string, b: string): PersonNameRelation | null {
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (!pa.key || !pb.key) return null;
  if (pa.key === pb.key) return 'same';
  if (isInitialForm(pa, pb) || isInitialForm(pb, pa)) return 'initial';
  const [short, long] = pa.parts.length <= pb.parts.length ? [pa, pb] : [pb, pa];
  if (short.parts.length < long.parts.length && !short.initials.some(Boolean)) {
    const rest = [...long.parts];
    const contained = short.parts.every((p) => {
      const i = rest.indexOf(p);
      if (i < 0) return false;
      rest.splice(i, 1);
      return true;
    });
    if (contained) {
      const hasFirst = short.parts.includes(long.parts[0]!);
      const hasLast = short.parts.includes(long.parts[long.parts.length - 1]!);
      if (hasFirst && !hasLast) return 'first_name_only';
      if (hasLast && !hasFirst) return 'last_name_only';
      return 'middle_name';
    }
  }
  return nameSimilarity(pa.key, pb.key) >= SIMILAR_SPELLING ? 'similar_spelling' : null;
}
